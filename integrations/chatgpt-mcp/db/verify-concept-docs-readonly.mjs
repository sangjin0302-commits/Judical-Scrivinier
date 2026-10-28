import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { postgresConnectionOptions } from "./pg-connection.mjs";

async function scalar(client, sql, params = []) {
  return Number((await client.query(sql, params)).rows[0].count);
}

export async function verifyConceptDocs(client) {
  await client.query("BEGIN READ ONLY");
  try {
    const result = {
      units: await scalar(client, "SELECT count(*) FROM units WHERE subject_id='CIVIL'"),
      recallQuestions: await scalar(client, "SELECT count(*) FROM recall_questions WHERE subject_id='CIVIL'"),
      mappedRecallQuestions: await scalar(client, "SELECT count(*) FROM recall_questions WHERE subject_id='CIVIL' AND content_state <> 'indexed-unavailable'"),
      availableUnits: await scalar(client, "SELECT count(*) FROM units WHERE subject_id='CIVIL' AND content_state IN ('available','verified')"),
      conceptIssues: await scalar(client, "SELECT count(*) FROM concept_issues WHERE subject_id='CIVIL'"),
      problemVersions: await scalar(client, "SELECT count(*) FROM problem_versions WHERE subject_id='CIVIL'"),
      snapshottedIssueItems: await scalar(client, "SELECT count(*) FROM issue_set_items WHERE subject_id='CIVIL' AND problem_version_id IS NOT NULL"),
      unsnapshottedIssueItems: await scalar(client, "SELECT count(*) FROM issue_set_items WHERE subject_id='CIVIL' AND problem_version_id IS NULL"),
      sourceDocuments: await scalar(client, "SELECT count(*) FROM source_documents WHERE subject_id='CIVIL'"),
      syncRuns: await scalar(client, "SELECT count(*) FROM sync_runs"),
      migrations: await scalar(client, "SELECT count(*) FROM schema_migrations WHERE migration_name IN ('0003_concept_learning.sql','0004_google_docs_sync.sql')"),
    };
    if (result.units !== 240 || result.recallQuestions !== 720) throw new Error("concept index count mismatch");
    if (result.availableUnits !== 7 || result.mappedRecallQuestions !== 21) throw new Error("verified source availability mismatch");
    if (result.problemVersions !== 9445 || result.unsnapshottedIssueItems !== 0) throw new Error("problem snapshot mismatch");
    if (result.migrations !== 2) throw new Error("migration ledger mismatch");
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool(postgresConnectionOptions(connectionString, { max: 1 }));
  const client = await pool.connect();
  try { process.stdout.write(JSON.stringify(await verifyConceptDocs(client))); }
  finally { client.release(); await pool.end(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
