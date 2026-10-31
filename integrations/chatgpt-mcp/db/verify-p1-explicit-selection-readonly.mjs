// Aggregate-only acceptance for source-backed P1 exam identifiers.
import pg from "pg";
import { postgresConnectionOptions } from "./pg-connection.mjs";
import { selectExamCandidates } from "./fast-exam-selection.mjs";

const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool(postgresConnectionOptions(connectionString, { max: 1 }));
const client = await pool.connect();
try {
  await client.query("BEGIN READ ONLY");
  const mapped = await client.query(`SELECT count(*)::int AS count FROM problems
    WHERE subject_id='CIVIL' AND stage='P1'
      AND selection_metadata->>'examMetadataProvenance'='DOCS_EXPLICIT_HEADING_2026'`);
  const key = await client.query(`SELECT encryption_key_id FROM private_grading_keys
    WHERE subject_id='CIVIL' AND verification_state='verified' AND active_for_grading=true
    GROUP BY encryption_key_id ORDER BY count(*) DESC LIMIT 1`);
  if (key.rowCount !== 1) throw new Error("verified key generation unavailable");
  const selected = await selectExamCandidates(client, {
    ownerId: "readonly-p1-metadata-probe", stage: "P1", requestId: "p1-2026-9-1-probe",
    keyId: key.rows[0].encryption_key_id, mode: "전범위", count: 1,
    year: "2026", session: "9", questionNumber: "1",
  });
  await client.query("ROLLBACK");
  process.stdout.write(JSON.stringify({ readOnly: true, mapped: mapped.rows[0].count,
    selected: selected.length, match: selected.every((row) =>
      row.selection_metadata?.year === "2026" && row.selection_metadata?.session === "9" &&
      row.selection_metadata?.questionNumber === "1") }));
} finally {
  client.release();
  await pool.end();
}
