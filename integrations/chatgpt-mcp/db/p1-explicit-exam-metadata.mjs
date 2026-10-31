// Maintainer-only, source-backed P1 metadata. Never derives an exam from stable-key digits.
import { readFile } from "node:fs/promises";
import pg from "pg";
import { postgresConnectionOptions } from "./pg-connection.mjs";

const DATA_URL = new URL("./data/p1-explicit-exam-metadata-2026.json", import.meta.url);
const PROVENANCE = "DOCS_EXPLICIT_HEADING_2026";

export function verifyP1SourceRevisions(data, observed) {
  for (const sourceId of ["SRC-CIV-004", "SRC-CIV-004B"]) {
    if (typeof data?.sourceDocs?.[sourceId] !== "string" ||
        typeof data?.sourceRevisions?.[sourceId] !== "string" ||
        data.sourceRevisions[sourceId].length < 20 ||
        data.sourceRevisions[sourceId] !== observed?.[sourceId]) {
      throw new Error("Google Docs source revision changed or unverified");
    }
  }
  return true;
}

export function validateP1ExamMetadata(data) {
  if (!data || !Array.isArray(data.records) || data.records.length === 0) throw new Error("missing verified exam metadata");
  const seen = new Set();
  return data.records.map((record) => {
    const { stableKey, sourceId, year, session, questionNumber } = record;
    if (typeof stableKey !== "string" || typeof sourceId !== "string" ||
        !stableKey.startsWith(`${sourceId}|`) || !/^SRC-CIV-004B?$/.test(sourceId) ||
        year !== "2026" || !/^(1|2|5|6|7|8|9)$/.test(session) ||
        !/^[1-9][0-9]{0,2}$/.test(questionNumber) || seen.has(stableKey)) {
      throw new Error("invalid or duplicate verified exam metadata");
    }
    seen.add(stableKey);
    return { stableKey, sourceId, year, session, questionNumber };
  });
}

export async function reconcileP1ExamMetadata(client, records, { apply = false } = {}) {
  const verified = validateP1ExamMetadata({ records });
  await client.query(apply ? "BEGIN ISOLATION LEVEL SERIALIZABLE" : "BEGIN READ ONLY");
  try {
    const found = await client.query(`SELECT stable_key,stage,selection_metadata FROM problems
      WHERE subject_id='CIVIL' AND stable_key=ANY($1::text[])
      ${apply ? "FOR UPDATE" : ""}`, [verified.map((r) => r.stableKey)]);
    if (found.rowCount !== verified.length) throw new Error("source-backed keys missing in database");
    const expected = new Map(verified.map((r) => [r.stableKey, r]));
    const updates = [];
    for (const row of found.rows) {
      const item = expected.get(row.stable_key);
      const meta = row.selection_metadata || {};
      if (row.stage !== "P1" || meta.sourceId !== item.sourceId) throw new Error("source identity mismatch");
      for (const field of ["year", "session", "questionNumber"]) {
        if (meta[field] != null && String(meta[field]) !== item[field]) {
          throw new Error("existing exam metadata conflicts with source evidence");
        }
      }
      if (meta.year !== item.year || meta.session !== item.session ||
          meta.questionNumber !== item.questionNumber || meta.examMetadataProvenance !== PROVENANCE) {
        updates.push(item);
      }
    }
    let changed = 0;
    if (apply && updates.length) {
      const result = await client.query(`UPDATE problems AS p SET selection_metadata =
        p.selection_metadata || jsonb_build_object('year',v.year,'session',v.session,
          'questionNumber',v.question_number,'examMetadataProvenance',$2::text)
        FROM jsonb_to_recordset($1::jsonb)
          AS v(stable_key text,year text,session text,question_number text)
        WHERE p.subject_id='CIVIL' AND p.stage='P1' AND p.stable_key=v.stable_key`,
      [JSON.stringify(updates.map((r) => ({ stable_key: r.stableKey, year: r.year,
        session: r.session, question_number: r.questionNumber }))), PROVENANCE]);
      if (result.rowCount !== updates.length) throw new Error("metadata update count mismatch");
      changed = result.rowCount;
    }
    await client.query("COMMIT");
    return { ok: true, applied: apply, sourceBacked: verified.length,
      alreadyMapped: verified.length - updates.length, pending: updates.length, changed };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

if (process.argv[1]?.endsWith("p1-explicit-exam-metadata.mjs")) {
  const apply = process.argv.includes("--apply");
  if (apply && (process.env.P1_EXAM_METADATA_TEST_ONLY !== "true" ||
      !process.argv.includes("--independent-test-db"))) {
    throw new Error("test-only metadata apply requires explicit guard");
  }
  const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const data = JSON.parse(await readFile(DATA_URL, "utf8"));
  const records = validateP1ExamMetadata(data);
  if (apply) verifyP1SourceRevisions(data, {
    "SRC-CIV-004": process.env.P1_DOC_REVISION_004,
    "SRC-CIV-004B": process.env.P1_DOC_REVISION_004B,
  });
  const pool = new pg.Pool(postgresConnectionOptions(connectionString, { max: 1 }));
  try {
    const client = await pool.connect();
    try { process.stdout.write(JSON.stringify(await reconcileP1ExamMetadata(client, records, { apply })) + "\n"); }
    finally { client.release(); }
  } catch (error) {
    process.stderr.write(`P1 metadata reconcile failed: ${error.name || "Error"}\n`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
