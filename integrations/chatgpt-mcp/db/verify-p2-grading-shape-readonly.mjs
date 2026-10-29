import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { decryptGradingPayload, gradingAad, gradingKey } from "./postgres-adapter.mjs";
import { postgresConnectionOptions } from "./pg-connection.mjs";

export async function verifyP2GradingShape(client, env = process.env) {
  await client.query("BEGIN READ ONLY");
  try {
    const sample = await client.query(`
      SELECT p.stable_key,k.key_version,k.encryption_key_id,k.encrypted_payload,k.payload_digest
        FROM problems p JOIN private_grading_keys k
          ON k.subject_id=p.subject_id AND k.stable_key=p.stable_key
       WHERE p.subject_id='CIVIL' AND p.stage='P2' AND p.published=true
         AND k.active_for_grading=true AND k.verification_state='verified'
       ORDER BY p.stable_key LIMIT 1`);
    if (sample.rowCount !== 1) throw new Error("verified P2 grading sample unavailable");
    const row = sample.rows[0];
    if (row.encryption_key_id !== env.GRADING_ENCRYPTION_KEY_ID) {
      throw new Error("P2 encryption key identity mismatch");
    }
    const payload = decryptGradingPayload(row.encrypted_payload, gradingKey(env),
      gradingAad("CIVIL", row.stable_key, row.key_version, row.encryption_key_id), row.payload_digest);
    const result = {
      decrypted: true,
      answerNonempty: typeof payload.answer === "string" && payload.answer.trim().length > 0,
      modelAnswerNonempty: typeof (payload.modelAnswer ?? payload.answer) === "string" &&
        (payload.modelAnswer ?? payload.answer).trim().length > 0,
      rubricNonempty: typeof payload.rubric === "string" && payload.rubric.trim().length > 0,
      rationaleNonempty: typeof payload.rationale === "string" && payload.rationale.trim().length > 0,
    };
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool(postgresConnectionOptions(connectionString, { max: 1 }));
  const client = await pool.connect();
  try { process.stdout.write(JSON.stringify(await verifyP2GradingShape(client)) + "\n"); }
  finally { client.release(); await pool.end(); }
}
