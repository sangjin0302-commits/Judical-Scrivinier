import pg from "pg";
import { postgresConnectionOptions } from "./pg-connection.mjs";

const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool(postgresConnectionOptions(connectionString, { max: 1 }));
const client = await pool.connect();
try {
  await client.query("BEGIN READ ONLY");
  const result = await client.query(`
    SELECT
      (SELECT count(*)::integer FROM document_folders WHERE subject_id='CIVIL') AS folders,
      (SELECT count(*)::integer FROM document_registry WHERE subject_id='CIVIL' AND registration_kind='EXTERNAL') AS legacy_sources,
      (SELECT count(*)::integer FROM document_registry WHERE subject_id='CIVIL' AND registration_kind='FOLDER') AS discovered_sources,
      (SELECT count(*)::integer FROM problems WHERE subject_id='CIVIL') AS civil_problems,
      (SELECT count(*)::integer FROM problems WHERE subject_id='CIVIL' AND stable_key ~ '^SRC-CIV-(004|004B|005)\\|') AS legacy_stable_keys,
      (SELECT count(*)::integer FROM problems p JOIN document_registry r
         ON r.subject_id=p.subject_id AND p.stable_key LIKE r.source_id || '|%'
        WHERE r.registration_kind='FOLDER') AS discovered_problem_rows,
      (SELECT count(*)::integer FROM problems p JOIN document_registry r
         ON r.subject_id=p.subject_id AND p.stable_key LIKE r.source_id || '|%'
        WHERE r.registration_kind='FOLDER' AND p.published) AS discovered_published_rows`);
  await client.query("COMMIT");
  process.stdout.write(JSON.stringify({ readOnly: true, ...result.rows[0] }) + "\n");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
