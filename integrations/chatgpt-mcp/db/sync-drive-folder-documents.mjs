import pg from "pg";

import { googleAccessToken } from "./dry-run-google-docs-sync.mjs";
import { listFolderDocuments, missingManagedDocuments, registerDiscoveredDocument,
  markMissingDocumentForReview, recordDocumentFailure, recordDocumentSync } from "./drive-document-registry.mjs";
import { fetchGoogleDocReadOnly, detectGoogleDocsChanges, applyApprovedSyncCandidate,
  sha256 } from "./google-docs-sync.mjs";
import { snapshotFromGoogleDoc } from "./google-docs-snapshot.mjs";
import { postgresConnectionOptions } from "./pg-connection.mjs";

async function withClient(pool, action) {
  const client = await pool.connect();
  try { return await action(client); } finally { client.release(); }
}

function countsFor(result) {
  if (result.counts) return result.counts;
  return Object.fromEntries(["NEW", "MODIFIED", "UNCHANGED", "DUPLICATE", "DELETE_CANDIDATE"]
    .map((kind) => [kind, result.candidates.filter((item) => item.candidate_kind === kind).length]));
}

export async function syncDriveFolderDocuments({ env = process.env, fetchImpl = fetch,
  Pool = pg.Pool, tokenProvider = googleAccessToken, listFiles = listFolderDocuments,
  fetchDocument = fetchGoogleDocReadOnly, snapshotParser = snapshotFromGoogleDoc,
  detect = detectGoogleDocsChanges, apply = applyApprovedSyncCandidate,
  register = registerDiscoveredDocument, record = recordDocumentSync,
  markMissing = markMissingDocumentForReview, recordFailure = recordDocumentFailure } = {}) {
  const connectionString = env.DATABASE_PUBLIC_URL || env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const accessToken = await tokenProvider(env, fetchImpl);
  const pool = new Pool(postgresConnectionOptions(connectionString, { max: 2 }));
  try {
    const folders = (await pool.query(
      `SELECT folder_id AS "folderId",subject_id AS "subjectId",stage,enabled
         FROM document_folders WHERE enabled=true AND subject_id='CIVIL'
         ORDER BY folder_id`)).rows;
    const discovered = [];
    const folderErrors = [];
    for (const folder of folders) {
      try {
        const files = await listFiles(folder.folderId, accessToken, fetchImpl);
        discovered.push(...files.map((file) => ({ ...file, subjectId: folder.subjectId,
          stage: folder.stage })));
      } catch (error) {
        folderErrors.push({ folderId: folder.folderId, code: "FOLDER_LIST_FAILED" });
      }
    }
    const documentOccurrences = new Map();
    for (const file of discovered) documentOccurrences.set(file.documentId,
      (documentOccurrences.get(file.documentId) || 0) + 1);
    const results = [];
    for (const file of discovered) {
      if (documentOccurrences.get(file.documentId) > 1) {
        if (results.some((item) => item.documentId === file.documentId)) continue;
        results.push({ documentId: file.documentId, status: "REVIEW", code: "MULTIPLE_FOLDERS" });
        continue;
      }
      let registration;
      try {
        registration = await withClient(pool, (client) => register(client, file));
        if (["EXTERNAL", "REVIEW"].includes(registration.status)) {
          results.push({ documentId: file.documentId, sourceId: registration.sourceId,
            status: registration.status });
          continue;
        }
        if (file.driveVersion && registration.lastSyncedDriveVersion === file.driveVersion &&
            ["STAGED", "READY"].includes(registration.status)) {
          results.push({ documentId: file.documentId, sourceId: registration.sourceId,
            status: "UNCHANGED" });
          continue;
        }
        const document = await fetchDocument({ documentId: file.documentId, accessToken, fetchImpl });
        const snapshot = snapshotParser(document, registration.sourceId, file.stage);
        if (!snapshot.problems.length) throw new Error("NO_PROBLEMS");
        const requestId = "drive-detect:" + sha256({ documentId: file.documentId,
          revisionId: snapshot.revisionId, digest: snapshot.contentDigest });
        const detected = await detect(pool, { ...snapshot, requestId }, "maintenance:drive-folder");
        const counts = countsFor(detected);
        let stagedNew = 0;
        // NEW is staged unpublished; content changes and grading key changes never auto-approved.
        for (const candidate of detected.candidates) {
          if (candidate.candidate_kind !== "NEW" || candidate.state !== "PENDING") continue;
          await apply(pool, { candidateId: candidate.candidate_id,
            actorId: "maintenance:drive-folder", autoStageNew: true });
          stagedNew += 1;
        }
        await withClient(pool, (client) => record(client, file.documentId, {
          revisionId: snapshot.revisionId, driveVersion: file.driveVersion,
          counts, problemCount: snapshot.problems.length, status: "STAGED" }));
        results.push({ documentId: file.documentId, sourceId: registration.sourceId,
          status: "STAGED", counts, stagedNew });
      } catch (error) {
        if (registration) await withClient(pool, (client) =>
          recordFailure(client, file.documentId,
            error.message === "NO_PROBLEMS" ? "NO_PROBLEMS" : "SYNC_FAILED"));
        results.push({ documentId: file.documentId, sourceId: registration?.sourceId || null,
          status: "ERROR", code: error.message === "NO_PROBLEMS" ? "NO_PROBLEMS" : "SYNC_FAILED" });
      }
    }
    let missingReview = 0;
    if (!folderErrors.length) {
      const registered = (await pool.query(
        `SELECT document_id AS "documentId",registration_kind AS "registrationKind"
           FROM document_registry WHERE subject_id='CIVIL'`)).rows;
      for (const documentId of missingManagedDocuments(registered, discovered, { completeScan: true })) {
        if (await withClient(pool, (client) => markMissing(client, documentId)))
          missingReview += 1;
      }
    }
    return { ok: folderErrors.length === 0 && results.every((item) => item.status !== "ERROR"),
      appliedToPublishedBank: false, folderErrors, documents: results, missingReview };
  } finally {
    await pool.end();
  }
}
