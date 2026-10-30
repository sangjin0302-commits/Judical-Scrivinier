import { googleAccessToken } from "./dry-run-google-docs-sync.mjs";
import { listFolderDocuments } from "./drive-document-registry.mjs";

const PREVIEW_HOST = "civil-p1-mcp-test-git-integ-e09f5d-sangjin0302-commits-projects.vercel.app";

export function driveDiagnosticEnabled(env, ownerId) {
  const admins = String(env.DRIVE_DIAGNOSTIC_ADMIN_USER_IDS || "").split(",")
    .map((value) => value.trim()).filter(Boolean);
  return env.DRIVE_DIAGNOSTIC_ENABLED === "true" && env.VERCEL_ENV === "preview" &&
    env.VERCEL_GIT_COMMIT_REF === "integration/civil-exam-only" &&
    env.VERCEL_BRANCH_URL === PREVIEW_HOST && Boolean(ownerId) && admins.includes(ownerId);
}

// ownerId must come from the existing authenticated MCP context, never input.
// This opt-in Preview diagnostic adds only aggregate metadata to progress.
export async function withDriveSourceHealth(progress, { pool, ownerId, env = process.env,
  fetchImpl = fetch, tokenProvider = googleAccessToken, listFiles = listFolderDocuments,
  timeoutMs = 8000 } = {}) {
  if (!driveDiagnosticEnabled(env, ownerId)) return progress;
  const controller = new AbortController();
  let timer;
  const timedFetch = (url, options = {}) => fetchImpl(url, { ...options, signal: controller.signal });
  const diagnostic = async () => {
    let token;
    try { token = await tokenProvider(env, timedFetch); }
    catch { return { ok: false, readOnly: true, code: "GOOGLE_AUTH_FAILED" }; }
    if (controller.signal.aborted) return { ok: false, readOnly: true, code: "TIMEOUT" };
    let folders;
    try {
      folders = (await pool.query({ text: `SELECT folder_id AS "folderId",stage
        FROM document_folders WHERE enabled=true AND subject_id='CIVIL' ORDER BY folder_id`,
        query_timeout: timeoutMs })).rows;
    } catch { return { ok: false, readOnly: true, code: "FOLDER_REGISTRY_FAILED" }; }
    if (!folders.length) return { ok: false, readOnly: true, code: "NO_ENABLED_FOLDERS" };
    const counts = [];
    for (const folder of folders) {
      if (controller.signal.aborted) return { ok: false, readOnly: true, code: "TIMEOUT" };
      try {
        const files = await listFiles(folder.folderId, token, timedFetch);
        counts.push({ stage: folder.stage, documentCount: files.length, ok: true });
      } catch { counts.push({ stage: folder.stage, ok: false, code: "FOLDER_LIST_FAILED" }); }
    }
    return { ok: counts.every((item) => item.ok), readOnly: true, folders: counts };
  };
  try {
    const sourceHealth = await Promise.race([diagnostic(), new Promise((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve({ ok: false, readOnly: true, code: "TIMEOUT" }); }, timeoutMs);
    })]);
    return { ...progress, sourceHealth };
  } catch {
    return { ...progress, sourceHealth: { ok: false, readOnly: true, code: "DIAGNOSTIC_FAILED" } };
  } finally { clearTimeout(timer); }
}
