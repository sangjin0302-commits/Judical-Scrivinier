import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { postgresConnectionOptions } from "./pg-connection.mjs";

export async function verifyRecallIssueLinks(client) {
  await client.query("BEGIN READ ONLY");
  try {
    const result = (await client.query(`
      SELECT
        (SELECT count(*)::integer FROM recall_questions WHERE subject_id='CIVIL') AS question_count,
        (SELECT count(*)::integer FROM recall_question_issue_links WHERE subject_id='CIVIL') AS linked_count,
        (SELECT count(*)::integer FROM recall_question_issue_links l
           JOIN recall_questions q ON q.subject_id=l.subject_id AND q.question_id=l.question_id
           JOIN concept_issues i ON i.subject_id=l.subject_id AND i.issue_id=l.issue_id
          WHERE l.subject_id='CIVIL' AND q.unit_id=i.unit_id
            AND q.content_state='source-mapped' AND l.verification_state='source-mapped') AS verified_count,
        (SELECT count(*)::integer FROM recall_attempts WHERE subject_id='CIVIL') AS attempt_count
    `)).rows[0];
    if (result.question_count !== 720 || result.linked_count !== 21 || result.verified_count !== 21) {
      throw new Error("recall issue link parity mismatch");
    }
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
  try { process.stdout.write(JSON.stringify(await verifyRecallIssueLinks(client)) + "\n"); }
  finally { client.release(); await pool.end(); }
}
