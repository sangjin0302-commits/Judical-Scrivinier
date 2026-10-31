import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { postgresConnectionOptions } from "./pg-connection.mjs";

// Aggregate wording signals only. These are triage signals, not legal quality judgments.
export async function auditRecallPrompts(client) {
  await client.query("BEGIN READ ONLY");
  try {
    const rows = (await client.query(`
      SELECT content_state, count(*)::integer AS total,
        count(*) FILTER (WHERE prompt_text ~ '(핵심 법리|전체 법리|기본 원리|전체 구조)')::integer AS broad_wording,
        count(*) FILTER (WHERE prompt_text ~ '(당사자|누가|누구|청구)')::integer AS party_cue,
        count(*) FILTER (WHERE prompt_text ~ '(요건|조건|확인|판단|필요한 사실)')::integer AS element_cue,
        count(*) FILTER (WHERE prompt_text ~ '(효과|효력|권리|의무|취소|해제)')::integer AS effect_cue,
        count(*) FILTER (WHERE prompt_text ~ '(예외|제한|다만|특별)')::integer AS exception_cue
      FROM recall_questions WHERE subject_id='CIVIL'
      GROUP BY content_state ORDER BY content_state
    `)).rows;
    const total = rows.reduce((sum, row) => sum + row.total, 0);
    if (total !== 720) throw new Error("recall question count mismatch");
    await client.query("COMMIT");
    return { total, rows };
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
  try { process.stdout.write(JSON.stringify(await auditRecallPrompts(client)) + "\n"); }
  finally { client.release(); await pool.end(); }
}
