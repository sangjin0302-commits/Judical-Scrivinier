import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { parseCsv } from "./import-concept-curriculum.mjs";
import { postgresConnectionOptions } from "./pg-connection.mjs";

const SUBJECT = "CIVIL";
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function validateRecallIssueLinks(rows, questions, issues) {
  if (rows.length !== 21) throw new Error("expected 21 source-mapped recall links");
  const questionById = new Map(questions.map((row) => [row.question_id, row]));
  const issueById = new Map(issues.map((row) => [row.issue_id, row]));
  const seen = new Set();
  const units = new Set();
  for (const row of rows) {
    const question = questionById.get(row.question_id);
    const issue = issueById.get(row.issue_id);
    if (!question || !issue || question.unit_id !== issue.unit_id ||
        question.content_state !== "source-mapped" ||
        row.verification_state !== "source-mapped" ||
        row.source_path !== `recall/${question.unit_id}.md` ||
        seen.has(row.question_id)) throw new Error("recall issue link source mismatch");
    seen.add(row.question_id);
    units.add(question.unit_id);
  }
  if (units.size !== 7) throw new Error("expected seven verified source units");
  return rows;
}

export async function importRecallIssueLinks(pool, csvText) {
  const rows = parseCsv(csvText);
  const sourceDigest = digest(csvText);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["civil-recall-issue-links"]);
    const [questions, issues] = await Promise.all([
      client.query("SELECT question_id,unit_id,content_state FROM recall_questions WHERE subject_id=$1", [SUBJECT]),
      client.query("SELECT issue_id,unit_id FROM concept_issues WHERE subject_id=$1", [SUBJECT]),
    ]);
    validateRecallIssueLinks(rows, questions.rows, issues.rows);
    let inserted = 0;
    for (const row of rows) {
      const result = await client.query(
        `INSERT INTO recall_question_issue_links
           (subject_id,question_id,issue_id,verification_state,source_path,source_digest)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT(subject_id,question_id,issue_id) DO NOTHING`,
        [SUBJECT, row.question_id, row.issue_id, row.verification_state, row.source_path, sourceDigest]);
      inserted += result.rowCount;
    }
    const existing = await client.query(
      "SELECT question_id,issue_id,source_digest FROM recall_question_issue_links WHERE subject_id=$1", [SUBJECT]);
    if (existing.rowCount !== 21 || existing.rows.some((row) => row.source_digest !== sourceDigest ||
        !rows.some((item) => item.question_id === row.question_id && item.issue_id === row.issue_id))) {
      throw new Error("existing recall issue links differ; review required");
    }
    await client.query("COMMIT");
    return { ok: true, total: rows.length, inserted, sourceDigest };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  const csvText = await readFile(resolve(repositoryRoot, "curriculum/recall-question-issue-links.csv"), "utf8");
  const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool(postgresConnectionOptions(connectionString, { max: 1 }));
  try {
    const result = await importRecallIssueLinks(pool, csvText);
    process.stdout.write(JSON.stringify({ ok: result.ok, total: result.total, inserted: result.inserted }) + "\n");
  } finally { await pool.end(); }
}
