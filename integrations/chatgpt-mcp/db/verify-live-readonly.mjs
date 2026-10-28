import pg from "pg";

const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error("database URL is unavailable");

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: true } });
await client.connect();
try {
  await client.query("BEGIN READ ONLY");
  const tables = [
    "problems", "private_grading_keys", "issue_sets", "issue_set_items", "submissions",
    "original_answers", "p1_grades", "p2_grades", "learning_events",
  ];
  const counts = {};
  for (const table of tables) {
    const result = await client.query(`SELECT count(*)::int AS count FROM ${table}`);
    counts[table] = result.rows[0].count;
  }
  const failedSet = await client.query(
    `SELECT set_id, state,
            (SELECT count(*)::int FROM original_answers a
              JOIN submissions s USING(submission_id) WHERE s.set_id=i.set_id) AS original_answers,
            (SELECT count(*)::int FROM p2_grades g
              JOIN submissions s USING(submission_id) WHERE s.set_id=i.set_id) AS p2_grades
       FROM issue_sets i WHERE set_id=$1`, ["P2-20261028-133103-a20116"]);
  const schema = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name='problems'
        AND column_name IN ('source_version','selection_metadata') ORDER BY column_name`);
  await client.query("ROLLBACK");
  process.stdout.write(JSON.stringify({ ok: true, transaction: "READ ONLY", counts,
    failedSet: failedSet.rows[0] || null, problemSchema: schema.rows }));
} finally {
  await client.end();
}
