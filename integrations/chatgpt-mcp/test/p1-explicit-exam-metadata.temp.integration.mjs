// Runs only against independent test Railway service. Session TEMP table shadows public.problems.
// No persistent DB relation is read or changed by the reconciler in this drill.
import assert from "node:assert/strict";
import pg from "pg";
import { postgresConnectionOptions } from "../db/pg-connection.mjs";
import { reconcileP1ExamMetadata } from "../db/p1-explicit-exam-metadata.mjs";

if (process.env.P1_EXAM_METADATA_TEMP_TEST_ONLY !== "true") {
  throw new Error("independent test temp-table drill requires explicit guard");
}
const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool(postgresConnectionOptions(connectionString, { max: 1 }));
const client = await pool.connect();
try {
  await client.query(`CREATE TEMP TABLE problems (
    subject_id text NOT NULL,stable_key text PRIMARY KEY,stage text NOT NULL,
    source_version text NOT NULL,prompt_text text NOT NULL,selection_metadata jsonb NOT NULL
  ) ON COMMIT PRESERVE ROWS`);
  const records = [
    { stableKey: "SRC-CIV-004|synthetic-1", sourceId: "SRC-CIV-004", year: "2026", session: "1", questionNumber: "1" },
    { stableKey: "SRC-CIV-004B|synthetic-2", sourceId: "SRC-CIV-004B", year: "2026", session: "9", questionNumber: "2" },
  ];
  for (const record of records) {
    await client.query(`INSERT INTO problems(subject_id,stable_key,stage,source_version,prompt_text,selection_metadata)
      VALUES('CIVIL',$1,'P1','v1','synthetic OX',$2)`,
    [record.stableKey, JSON.stringify({ sourceId: record.sourceId, originalId: "synthetic" })]);
  }
  const before = await client.query("SELECT md5(string_agg(stable_key||source_version||prompt_text,'|' ORDER BY stable_key)) AS digest FROM problems");
  const dry = await reconcileP1ExamMetadata(client, records);
  assert.equal(dry.pending, 2);
  const applied = await reconcileP1ExamMetadata(client, records, { apply: true });
  assert.equal(applied.changed, 2);
  const replay = await reconcileP1ExamMetadata(client, records, { apply: true });
  assert.equal(replay.changed, 0);
  const selected = await client.query(`SELECT stable_key FROM problems
    WHERE selection_metadata->>'year'='2026' AND selection_metadata->>'session'='9'
      AND selection_metadata->>'questionNumber'='2'`);
  assert.equal(selected.rowCount, 1);
  const after = await client.query("SELECT md5(string_agg(stable_key||source_version||prompt_text,'|' ORDER BY stable_key)) AS digest FROM problems");
  assert.equal(after.rows[0].digest, before.rows[0].digest);
  await assert.rejects(reconcileP1ExamMetadata(client,
    [{ ...records[0], questionNumber: "3" }, records[1]], { apply: true }), /conflicts/);
  const postRollback = await client.query("SELECT selection_metadata->>'questionNumber' AS number FROM problems WHERE stable_key=$1", [records[0].stableKey]);
  assert.equal(postRollback.rows[0].number, "1");
  process.stdout.write(JSON.stringify({ ok: true, isolatedTempTable: true, dryRun: true,
    applied: 2, replayChanged: 0, exactFilter: true, contentPreserved: true,
    conflictingProvenanceRolledBack: true }) + "\n");
} finally {
  client.release();
  await pool.end();
}
