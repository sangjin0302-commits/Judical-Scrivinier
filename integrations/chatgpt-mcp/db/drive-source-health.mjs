import { googleAccessToken } from "./dry-run-google-docs-sync.mjs";
import { listFolderDocuments } from "./drive-document-registry.mjs";
import { createHash } from "node:crypto";

const PREVIEW_HOST = "civil-p1-mcp-test-git-integ-e09f5d-sangjin0302-commits-projects.vercel.app";
const SAFE_DRIVE_REASONS = new Set(["insufficientPermissions", "accessNotConfigured",
  "SERVICE_DISABLED", "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "forbidden", "notFound",
  "rateLimitExceeded", "userRateLimitExceeded"]);

export async function readFolderMetadata(folderId, token, fetchImpl) {
  if (!/^[A-Za-z0-9_-]{10,}$/.test(folderId || "")) throw new Error("invalid folder id");
  const response = await fetchImpl(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=mimeType%2Ctrashed&supportsAllDrives=true`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error("folder metadata failed");
  return response.json();
}

export async function readDriveAccountFingerprint(token, fetchImpl) {
  try {
    const response = await fetchImpl("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)", {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) return { accountIdentityCode: "ACCOUNT_LOOKUP_FAILED",
      ...(Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
        ? { accountIdentityHttpStatus: response.status } : {}) };
    const email = (await response.json())?.user?.emailAddress;
    if (typeof email !== "string" || !email.trim() || email.length > 320) {
      return { accountIdentityCode: "ACCOUNT_EMAIL_UNAVAILABLE" };
    }
    return { accountEmailSha256: createHash("sha256").update(email.trim().toLowerCase()).digest("hex") };
  } catch { return { accountIdentityCode: "ACCOUNT_LOOKUP_FAILED" }; }
}

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
  checkFolder = readFolderMetadata,
  accountReader = readDriveAccountFingerprint,
  timeoutMs = 8000 } = {}) {
  if (!driveDiagnosticEnabled(env, ownerId)) return progress;
  const controller = new AbortController();
  let timer;
  let folderResult;
  let scopeSummary = { reported: false };
  const timedFetch = (url, options = {}) => fetchImpl(url, { ...options, signal: controller.signal });
  const tokenFetch = async (url, options) => {
    const response = await timedFetch(url, options);
    if (url === "https://oauth2.googleapis.com/token" && response.ok) {
      try {
        const payload = await response.clone().json();
        if (typeof payload.scope === "string" && payload.scope.trim()) {
          const scopes = new Set(payload.scope.trim().split(/\s+/));
          scopeSummary = { reported: true,
            driveMetadataReadonly: scopes.has("https://www.googleapis.com/auth/drive.metadata.readonly"),
            driveReadonly: scopes.has("https://www.googleapis.com/auth/drive.readonly"),
            driveFile: scopes.has("https://www.googleapis.com/auth/drive.file"),
            drive: scopes.has("https://www.googleapis.com/auth/drive") };
        }
      } catch { /* An omitted/unreadable scope is unverified, never assumed. */ }
    }
    return response;
  };
  const diagnostic = async () => {
    let token;
    try { token = await tokenProvider(env, tokenFetch); }
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
      let failureMetadata = {};
      const driveFetch = async (url, options) => {
        const response = await timedFetch(url, options);
        if (!response.ok) {
          if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599) {
            failureMetadata.httpStatus = response.status;
          }
          try {
            const payload = await response.clone().json();
            const error = payload?.error;
            const candidates = [error?.status,
              ...(Array.isArray(error?.errors) ? error.errors.map((item) => item?.reason) : []),
              ...(Array.isArray(error?.details) ? error.details.map((item) => item?.reason) : [])];
            const reasons = [...new Set(candidates.filter((reason) => SAFE_DRIVE_REASONS.has(reason)))];
            if (reasons.length) failureMetadata.reasons = reasons;
            const projectNumbers = [...new Set((Array.isArray(error?.details) ? error.details : [])
              .filter((detail) => detail?.reason === "SERVICE_DISABLED" &&
                detail?.metadata?.service === "drive.googleapis.com")
              .map((detail) => /^projects\/([1-9][0-9]{0,19})$/.exec(detail.metadata.consumer || "")?.[1])
              .filter(Boolean))];
            if (projectNumbers.length === 1) failureMetadata.projectNumber = projectNumbers[0];
          } catch { /* Provider bodies and messages are never returned. */ }
        }
        return response;
      };
      let folderVerified = false;
      try {
        const metadata = await checkFolder(folder.folderId, token, driveFetch);
        if (metadata?.mimeType !== "application/vnd.google-apps.folder" || metadata?.trashed !== false) {
          counts.push({ stage: folder.stage, ok: false, code: "FOLDER_INVALID_OR_TRASHED" });
          continue;
        }
        folderVerified = true;
        const files = await listFiles(folder.folderId, token, driveFetch);
        counts.push({ stage: folder.stage, documentCount: files.length, ok: true, folderVerified: true });
      } catch (error) { counts.push({ stage: folder.stage, ok: false,
        code: error?.message === "invalid folder id" ? "FOLDER_ID_INVALID" :
          folderVerified ? "FOLDER_LIST_FAILED" : "FOLDER_ACCESS_FAILED",
        ...failureMetadata }); }
    }
    // Account diagnostics run independently after folder checks. Failure must not
    // erase the already collected folder access result or expose the email.
    folderResult = { ok: counts.every((item) => item.ok), readOnly: true, folders: counts, scopeSummary,
      ...(typeof env.GOOGLE_CLIENT_ID === "string" && env.GOOGLE_CLIENT_ID.trim()
        ? { oauthClientIdSha256: createHash("sha256").update(env.GOOGLE_CLIENT_ID.trim()).digest("hex") } : {}) };
    const identity = await accountReader(token, timedFetch);
    return { ...folderResult, ...identity };
  };
  try {
    const sourceHealth = await Promise.race([diagnostic(), new Promise((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve(folderResult
        ? { ...folderResult, accountIdentityCode: "ACCOUNT_LOOKUP_TIMEOUT" }
        : { ok: false, readOnly: true, code: "TIMEOUT" }); }, timeoutMs);
    })]);
    return { ...progress, sourceHealth };
  } catch {
    return { ...progress, sourceHealth: { ok: false, readOnly: true, code: "DIAGNOSTIC_FAILED" } };
  } finally { clearTimeout(timer); }
}
