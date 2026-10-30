import { randomUUID } from "node:crypto";

const DOC_MIME = "application/vnd.google-apps.document";
const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
const ID = /^[A-Za-z0-9_-]{10,}$/;

export async function listFolderDocuments(folderId, accessToken, fetchImpl = fetch) {
  if (!ID.test(folderId)) throw new Error("invalid folder id");
  if (!accessToken) throw new Error("Google access token required");
  const files = [];
  const seenTokens = new Set();
  let pageToken;
  do {
    const query = new URLSearchParams({
      q: `'${folderId}' in parents and mimeType = '${DOC_MIME}' and trashed = false`,
      fields: "nextPageToken,files(id,name,mimeType,parents,modifiedTime,version,size,webViewLink)",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) query.set("pageToken", pageToken);
    const response = await fetchImpl(`${DRIVE_FILES}?${query}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error(`Google Drive folder list failed: ${response.status}`);
    const page = await response.json();
    if (!Array.isArray(page.files)) throw new Error("Google Drive folder list malformed");
    for (const file of page.files) {
      if (!ID.test(file.id || "") || file.mimeType !== DOC_MIME) continue;
      files.push({ documentId: file.id, title: String(file.name || ""), folderId,
        modifiedAt: file.modifiedTime || null, driveVersion: file.version || null,
        sizeBytes: file.size == null ? null : Number(file.size) });
    }
    pageToken = page.nextPageToken || undefined;
    if (pageToken && seenTokens.has(pageToken)) throw new Error("Google Drive pagination loop");
    if (pageToken) seenTokens.add(pageToken);
  } while (pageToken);
  return files;
}

export async function discoverFolderDocuments(folders, accessToken, fetchImpl = fetch) {
  const discovered = [];
  const seen = new Map();
  for (const folder of folders) {
    if (!folder.enabled) continue;
    const files = await listFolderDocuments(folder.folderId, accessToken, fetchImpl);
    for (const file of files) {
      const prior = seen.get(file.documentId);
      if (prior && prior.folderId !== file.folderId) {
        throw new Error("Google Doc appears in multiple configured folders");
      }
      seen.set(file.documentId, file);
      discovered.push({ ...file, subjectId: folder.subjectId, stage: folder.stage });
    }
  }
  return discovered;
}

function sourceIdFor(subjectId) {
  if (subjectId !== "CIVIL") throw new Error("parser not configured for subject");
  return `SRC-CIV-AUTO-${randomUUID().replaceAll("-", "")}`;
}

export async function registerDiscoveredDocument(client, file) {
  const { documentId, title, folderId, subjectId, stage } = file;
  if (![documentId, folderId].every((value) => ID.test(value || ""))) throw new Error("invalid Drive id");
  if (subjectId !== "CIVIL" || !["P1", "P2"].includes(stage)) throw new Error("unsupported source");
  await client.query("BEGIN");
  try {
    const folder = await client.query(
      "SELECT 1 FROM document_folders WHERE folder_id=$1 AND subject_id=$2 AND stage=$3 AND enabled=true",
      [folderId, subjectId, stage]);
    if (!folder.rowCount) throw new Error("unregistered folder");
    const prior = await client.query(
      "SELECT source_id,folder_id,registration_kind,registration_status,last_synced_drive_version FROM document_registry WHERE document_id=$1 FOR UPDATE",
      [documentId]);
    if (prior.rowCount) {
      const row = prior.rows[0];
      if (row.registration_kind === "EXTERNAL") {
        await client.query("COMMIT");
        return { sourceId: row.source_id, status: "EXTERNAL", replayed: true };
      }
      if (row.folder_id !== folderId) {
        await client.query(
          "UPDATE document_registry SET registration_status='REVIEW',failure_code='FOLDER_MOVE',last_seen_at=now(),updated_at=now() WHERE document_id=$1",
          [documentId]);
        await client.query(
          "INSERT INTO document_registry_events(document_id,event_kind,details) VALUES($1,'MOVE_REVIEW',$2::jsonb)",
          [documentId, JSON.stringify({ observedFolderId: folderId })]);
        await client.query("COMMIT");
        return { sourceId: row.source_id, status: "REVIEW", replayed: true };
      }
      await client.query(
        "UPDATE document_registry SET title=$2,last_seen_at=now(),updated_at=now() WHERE document_id=$1",
        [documentId, title]);
      await client.query("COMMIT");
      return { sourceId: row.source_id, status: row.registration_status,
        lastSyncedDriveVersion: row.last_synced_drive_version, replayed: true };
    }
    const sourceId = sourceIdFor(subjectId);
    await client.query(
      "INSERT INTO source_documents(document_id,subject_id,title,read_only) VALUES($1,$2,$3,true) ON CONFLICT(document_id) DO NOTHING",
      [documentId, subjectId, title]);
    await client.query(
      `INSERT INTO document_registry(document_id,source_id,subject_id,stage,folder_id,title,
         registration_kind,registration_status,last_seen_at)
       VALUES($1,$2,$3,$4,$5,$6,'FOLDER','DISCOVERED',now())`,
      [documentId, sourceId, subjectId, stage, folderId, title]);
    await client.query(
      "INSERT INTO document_registry_events(document_id,event_kind,details) VALUES($1,'REGISTERED','{}'::jsonb)",
      [documentId]);
    await client.query("COMMIT");
    return { sourceId, status: "DISCOVERED", replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function markMissingDocumentForReview(client, documentId) {
  const result = await client.query(
    `UPDATE document_registry SET registration_status='REVIEW',failure_code='NOT_FOUND',updated_at=now()
      WHERE document_id=$1 AND registration_kind='FOLDER' AND registration_status <> 'REVIEW'
      RETURNING document_id`, [documentId]);
  if (result.rowCount) await client.query(
    "INSERT INTO document_registry_events(document_id,event_kind,details) VALUES($1,'MISSING_REVIEW','{}'::jsonb)",
    [documentId]);
  return result.rowCount > 0;
}

// Call only after every configured folder page succeeded. A failed partial scan must
// never turn an unseen document into a deletion candidate.
export function missingManagedDocuments(registered, discovered, { completeScan = false } = {}) {
  if (!completeScan) throw new Error("complete Drive folder scan required");
  const seen = new Set(discovered.map((item) => item.documentId));
  return registered.filter((item) => item.registrationKind === "FOLDER" &&
    !seen.has(item.documentId)).map((item) => item.documentId);
}

export async function recordDocumentSync(client, documentId, { revisionId, driveVersion,
  counts, problemCount, status = "STAGED" }) {
  if (!["STAGED", "READY", "REVIEW", "ERROR"].includes(status)) throw new Error("invalid sync status");
  if (!Number.isInteger(problemCount) || problemCount < 0) throw new Error("invalid problem count");
  const result = await client.query(
    `UPDATE document_registry SET current_revision_id=$2,last_synced_drive_version=$3,last_synced_at=now(),
       parsed_problem_count=$4,last_counts=$5::jsonb,registration_status=$6,
       failure_code=NULL,updated_at=now() WHERE document_id=$1 RETURNING document_id`,
    [documentId, revisionId, driveVersion || null, problemCount, JSON.stringify(counts), status]);
  if (!result.rowCount) throw new Error("unregistered document");
  await client.query("INSERT INTO document_registry_events(document_id,event_kind,details) VALUES($1,'SYNCED',$2::jsonb)",
    [documentId, JSON.stringify({ revisionId, counts, problemCount, status })]);
}

export async function recordDocumentFailure(client, documentId, code) {
  const safeCode = String(code || "SYNC_FAILED").replace(/[^A-Z0-9_]/g, "").slice(0, 64);
  const result = await client.query(
    `UPDATE document_registry SET registration_status='ERROR',failure_code=$2,updated_at=now()
      WHERE document_id=$1 AND registration_kind='FOLDER' RETURNING document_id`,
    [documentId, safeCode || "SYNC_FAILED"]);
  if (result.rowCount) await client.query(
    "INSERT INTO document_registry_events(document_id,event_kind,details) VALUES($1,'FAILED',$2::jsonb)",
    [documentId, JSON.stringify({ code: safeCode || "SYNC_FAILED" })]);
  return result.rowCount > 0;
}

export function crossDocumentDuplicateCandidates(incoming, existing) {
  const byRawId = new Map();
  const byPrompt = new Map();
  for (const item of existing) {
    const rawId = String(item.stableKey || "").split("|").slice(1).join("|");
    if (rawId) (byRawId.get(rawId) || byRawId.set(rawId, []).get(rawId)).push(item);
    if (item.promptDigest) (byPrompt.get(item.promptDigest) || byPrompt.set(item.promptDigest, []).get(item.promptDigest)).push(item);
  }
  return incoming.flatMap((item) => {
    const rawId = String(item.stableKey || "").split("|").slice(1).join("|");
    const candidates = [...(byRawId.get(rawId) || []), ...(byPrompt.get(item.promptDigest) || [])]
      .filter((prior) => prior.documentId !== item.documentId);
    return candidates.length ? [{ stableKey: item.stableKey, kind: "CROSS_DOCUMENT_DUPLICATE",
      matchedKeys: [...new Set(candidates.map((prior) => prior.stableKey))] }] : [];
  });
}
