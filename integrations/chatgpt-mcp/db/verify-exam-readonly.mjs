// Aggregate-only Railway inventory. Never print connection strings, prompts, answers or keys.
import pg from "pg";
import { postgresConnectionOptions } from "./pg-connection.mjs";

export async function verifyExamInventory({ env = process.env, Pool = pg.Pool } = {}) {
  const connectionString = env.DATABASE_PUBLIC_URL || env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const pool = new Pool(postgresConnectionOptions(connectionString, { max: 1 }));
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const stages = await client.query(`SELECT stage::text AS stage,count(*)::int AS total,
      count(*) FILTER (WHERE published)::int AS published,
      count(*) FILTER (WHERE current_problem_version_id IS NULL)::int AS without_version
      FROM problems WHERE subject_id='CIVIL' GROUP BY stage ORDER BY stage`);
    const keys = await client.query(`SELECT p.stage::text AS stage,
      count(DISTINCT p.stable_key)::int AS eligible_with_verified_key
      FROM problems p JOIN private_grading_keys k
        ON k.subject_id=p.subject_id AND k.stable_key=p.stable_key
      WHERE p.subject_id='CIVIL' AND p.published=true
        AND p.current_problem_version_id IS NOT NULL
        AND k.verification_state='verified' AND k.active_for_grading=true
      GROUP BY p.stage ORDER BY p.stage`);
    const p2 = await client.query(`WITH grouped AS (
      SELECT regexp_replace(stable_key,'-소문항[0-9]+$','') AS group_key,
        count(*)::int AS subquestions
      FROM problems WHERE subject_id='CIVIL' AND stage='P2'
        AND stable_key ~ '-소문항[0-9]+$'
      GROUP BY 1)
      SELECT (SELECT count(*)::int FROM problems WHERE subject_id='CIVIL' AND stage='P2'
        AND stable_key !~ '-소문항[0-9]+$') AS incompatible_key_rows,
        count(*)::int AS groups,
        count(*) FILTER (WHERE subquestions>1)::int AS multi_subquestion_groups,
        coalesce(max(subquestions),0)::int AS largest_group FROM grouped`);
    await client.query("COMMIT");
    return { readOnly: true, stages: stages.rows, verifiedKeys: keys.rows, p2: p2.rows[0] };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("verify-exam-readonly.mjs")) {
  try {
    process.stdout.write(JSON.stringify(await verifyExamInventory()) + "\n");
  } catch (error) {
    process.stderr.write(JSON.stringify({ ok: false, code: error.code || error.name }) + "\n");
    process.exitCode = 1;
  }
}
