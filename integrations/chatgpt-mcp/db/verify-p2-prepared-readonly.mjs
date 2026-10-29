// Private read-only inventory. Emits counts only, never originals or grading content.
import pg from "pg";
import { postgresConnectionOptions } from "./pg-connection.mjs";
import { decryptGradingPayload, gradingAad, gradingKey } from "./postgres-adapter.mjs";
import { calculateP2LearningScore, isNonSubstantiveP2Answer } from "./p2-semantic-evaluation.mjs";

export async function verifyPreparedP2(client, env = process.env) {
  await client.query("BEGIN READ ONLY");
  try {
    const rows = await client.query(`SELECT s.submission_id,oa.stable_key,oa.answer_text,p.max_points,
      k.key_version,k.encryption_key_id,k.encrypted_payload,k.payload_digest
      FROM submissions s JOIN issue_sets sets ON sets.set_id=s.set_id
      JOIN original_answers oa ON oa.submission_id=s.submission_id
      JOIN problems p ON p.subject_id=oa.subject_id AND p.stable_key=oa.stable_key
      JOIN issue_set_items i ON i.set_id=s.set_id AND i.stable_key=oa.stable_key
      JOIN private_grading_keys k ON k.subject_id=oa.subject_id AND k.stable_key=oa.stable_key
        AND k.key_version=i.key_version AND k.encryption_key_id=i.encryption_key_id
      WHERE sets.subject_id='CIVIL' AND sets.stage='P2' AND s.state='PREPARED'
        AND k.verification_state='verified' ORDER BY s.submission_id,oa.stable_key LIMIT 100`);
    const committed = await client.query(`SELECT g.stable_key,oa.answer_text,i.key_version,i.encryption_key_id,
      CASE WHEN k.verification_state='verified' THEN true ELSE false END AS verified_source
      FROM p2_grades g JOIN submissions s ON s.submission_id=g.submission_id
      JOIN original_answers oa ON oa.submission_id=g.submission_id AND oa.stable_key=g.stable_key
      JOIN issue_set_items i ON i.set_id=s.set_id AND i.stable_key=g.stable_key
      LEFT JOIN private_grading_keys k ON k.subject_id=g.subject_id AND k.stable_key=g.stable_key
        AND k.key_version=i.key_version AND k.encryption_key_id=i.encryption_key_id
      WHERE s.subject_id='CIVIL' AND s.state='COMMITTED'`);
    const result = { readOnly: true, submittedPreparedItems: rows.rowCount,
      abstentions: 0, abstentionZeroScoreVerified: 0,
      officialSourceVerified: 0, unavailableKeyGeneration: 0,
      committedWithOriginal: committed.rowCount,
      committedNonAbstention: committed.rows.filter((item) => !isNonSubstantiveP2Answer(item.answer_text)).length,
      committedVerifiedSourceAvailable: committed.rows.filter((item) =>
        item.verified_source && item.encryption_key_id === env.GRADING_ENCRYPTION_KEY_ID).length };
    let key;
    for (const row of rows.rows) {
      if (isNonSubstantiveP2Answer(row.answer_text)) {
        result.abstentions++;
        if (calculateP2LearningScore([{ status: "MISSING" }], Number(row.max_points)).displayedPoints === 0) {
          result.abstentionZeroScoreVerified++;
        }
      }
      if (row.encryption_key_id !== env.GRADING_ENCRYPTION_KEY_ID) {
        result.unavailableKeyGeneration++;
        continue;
      }
      key ??= gradingKey(env);
      const source = decryptGradingPayload(row.encrypted_payload, key,
        gradingAad("CIVIL", row.stable_key, row.key_version, row.encryption_key_id), row.payload_digest);
      if (typeof source.answer === "string" && source.answer.trim() &&
          typeof source.rubric === "string" && source.rubric.trim()) result.officialSourceVerified++;
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

if (process.argv[1]?.endsWith("verify-p2-prepared-readonly.mjs")) {
  const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool(postgresConnectionOptions(connectionString, { max: 1 }));
  try {
    const client = await pool.connect();
    try { process.stdout.write(JSON.stringify(await verifyPreparedP2(client)) + "\n"); }
    finally { client.release(); }
  } catch (error) {
    process.stderr.write(`prepared P2 read-only audit failed: ${error.name || "Error"}\n`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
