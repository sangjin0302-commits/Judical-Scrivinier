import pg from "pg";

import { fetchGoogleDocsSnapshotReadOnly, dryRunGoogleDocsCandidates } from "./google-docs-snapshot.mjs";
import { postgresConnectionOptions } from "./pg-connection.mjs";

const SOURCES = [
  ["SRC-CIV-004", "169rzZ3qlM-LfZI7I6gCSwWEeJ4Cc8RiHZzH9Qm_dwys"],
  ["SRC-CIV-004B", "1hEQNsDti70lCSYG5PL90s7klhpqQJ-V4kERpSocuLLc"],
  ["SRC-CIV-005", "1xP0jLOUUQWzUGrv0whx7_z1cyVWAghxlGJVQo3Do_xA"],
];

function required(value, name) {
  if (!value) throw new Error(name + " is required");
  return value;
}

async function googleAccessToken(env, fetchImpl) {
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: required(env.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID"),
      client_secret: required(env.GOOGLE_CLIENT_SECRET, "GOOGLE_CLIENT_SECRET"),
      refresh_token: required(env.GOOGLE_REFRESH_TOKEN, "GOOGLE_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) throw new Error("Google OAuth refresh failed");
  return payload.access_token;
}

export async function dryRunAllGoogleDocs({ env = process.env, fetchImpl = fetch,
  Pool = pg.Pool, sources = SOURCES } = {}) {
  const accessToken = await googleAccessToken(env, fetchImpl);
  const connectionString = required(env.DATABASE_PUBLIC_URL || env.DATABASE_URL, "DATABASE_URL");
  const pool = new Pool(postgresConnectionOptions(connectionString, { max: 1 }));
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const summaries = [];
    for (const [sourceId, documentId] of sources) {
      const snapshot = await fetchGoogleDocsSnapshotReadOnly({ documentId, sourceId,
        accessToken, fetchImpl });
      const current = await client.query(
        `SELECT p.stable_key AS "stableKey", COALESCE(m.source_locator,p.source_ref) AS "sourceLocator",
                p.current_problem_version_id AS "currentVersionId", v.source_version AS "sourceVersion",
                v.source_order AS "sourceOrder", v.stage, v.unit_id AS "unitId",
                v.max_points AS "maxPoints", v.prompt_digest AS "promptDigest",
                v.answer_digest AS "answerDigest", v.explanation_digest AS "explanationDigest",
                v.grading_key_version AS "gradingKeyVersion", v.selection_metadata AS "selectionMetadata",
                m.document_id AS "mappedDocumentId"
           FROM problems p
           JOIN problem_versions v ON v.version_id=p.current_problem_version_id
           LEFT JOIN problem_source_map m ON m.subject_id=p.subject_id AND m.stable_key=p.stable_key
            AND m.active=true
          WHERE p.subject_id='CIVIL' AND p.stable_key LIKE $1`, [sourceId + "|%"]);
      summaries.push({ sourceId, dbCount: current.rowCount,
        ...dryRunGoogleDocsCandidates(snapshot, current.rows) });
    }
    await client.query("COMMIT");
    return { ok: true, readOnly: true, sources: summaries };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("dry-run-google-docs-sync.mjs")) {
  const result = await dryRunAllGoogleDocs();
  process.stdout.write(JSON.stringify(result) + "\n");
}
