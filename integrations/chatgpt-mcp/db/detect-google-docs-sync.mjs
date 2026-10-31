import pg from "pg";

import { SOURCES, googleAccessToken } from "./dry-run-google-docs-sync.mjs";
import { fetchGoogleDocsSnapshotReadOnly } from "./google-docs-snapshot.mjs";
import { detectGoogleDocsChanges, sha256 } from "./google-docs-sync.mjs";
import { postgresConnectionOptions } from "./pg-connection.mjs";

export async function detectAllGoogleDocs({ env = process.env, fetchImpl = fetch,
  Pool = pg.Pool, sources = SOURCES, detect = detectGoogleDocsChanges } = {}) {
  const accessToken = await googleAccessToken(env, fetchImpl);
  const connectionString = env.DATABASE_PUBLIC_URL || env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const pool = new Pool(postgresConnectionOptions(connectionString, { max: 1 }));
  try {
    const results = [];
    for (const [sourceId, documentId] of sources) {
      const snapshot = await fetchGoogleDocsSnapshotReadOnly({ documentId, sourceId,
        accessToken, fetchImpl });
      const requestId = "docs-detect:" + sha256({ documentId, revisionId: snapshot.revisionId,
        contentDigest: snapshot.contentDigest });
      const result = await detect(pool, { ...snapshot, requestId }, "maintenance:google-docs");
      const counts = result.counts || Object.fromEntries(
        ["NEW", "MODIFIED", "UNCHANGED", "DUPLICATE", "DELETE_CANDIDATE"]
          .map((kind) => [kind, result.candidates.filter((item) => item.candidate_kind === kind).length]));
      results.push({ sourceId, syncRunId: result.syncRunId, replayed: result.replayed,
        counts,
        candidates: result.candidates.filter((item) => item.candidate_kind !== "UNCHANGED")
          .map((item) => ({ candidateId: item.candidate_id, kind: item.candidate_kind })) });
    }
    return { ok: true, applied: false, sources: results };
  } finally {
    await pool.end();
  }
}
