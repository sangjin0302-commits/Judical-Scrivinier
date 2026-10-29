// Read-only inventory; never prints owner IDs, answers, scores or stable keys.
import pg from "pg";
import { postgresConnectionOptions } from "./pg-connection.mjs";

const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool(postgresConnectionOptions(connectionString, { max: 1 }));
const client = await pool.connect();
try {
  await client.query("BEGIN READ ONLY");
  const events = await client.query(`SELECT payload FROM learning_events
    WHERE subject_id='CIVIL' AND event_type='SHEET_HISTORY_IMPORTED'`);
  const shape = new Map();
  for (const row of events.rows) {
    const label = Object.keys(row.payload || {}).sort().join(",");
    shape.set(label, (shape.get(label) || 0) + 1);
  }
  const counts = await client.query(`SELECT
    (SELECT count(*)::int FROM p1_grades) AS p1_grades,
    (SELECT count(*)::int FROM p2_grades) AS p2_grades,
    (SELECT count(*)::int FROM original_answers) AS originals,
    (SELECT count(*)::int FROM exam_review_due) AS due_rows,
    (SELECT count(*)::int FROM issue_sets) AS sets,
    (SELECT count(*)::int FROM submissions) AS submissions,
    (SELECT count(DISTINCT (owner_id,stable_key))::int FROM learning_events
       WHERE subject_id='CIVIL' AND event_type='SHEET_HISTORY_IMPORTED') AS imported_owner_problem_pairs,
    (SELECT count(DISTINCT (s.owner_id,g.stable_key))::int FROM (
       SELECT submission_id,stable_key FROM p1_grades UNION ALL
       SELECT submission_id,stable_key FROM p2_grades) g
       JOIN submissions s ON s.submission_id=g.submission_id
       WHERE s.subject_id='CIVIL' AND s.state='COMMITTED') AS native_graded_owner_problem_pairs,
    (SELECT count(*)::int FROM submissions s JOIN issue_sets sets ON sets.set_id=s.set_id
       WHERE s.subject_id='CIVIL' AND sets.stage='P2' AND s.state='PREPARED'
         AND EXISTS(SELECT 1 FROM original_answers a WHERE a.submission_id=s.submission_id)
         AND NOT EXISTS(SELECT 1 FROM p2_grades g WHERE g.submission_id=s.submission_id))
       AS prepared_p2_sets_with_original_without_grade,
    (SELECT count(*)::int FROM original_answers a
       JOIN submissions s ON s.submission_id=a.submission_id
       JOIN issue_sets sets ON sets.set_id=s.set_id AND sets.stage='P2'
       WHERE s.subject_id='CIVIL' AND s.state='PREPARED'
         AND NOT EXISTS(SELECT 1 FROM p2_grades g WHERE g.submission_id=a.submission_id
           AND g.stable_key=a.stable_key)) AS prepared_p2_items_with_original_without_grade`);
  await client.query("ROLLBACK");
  process.stdout.write(JSON.stringify({ readOnly: true, importedRows: events.rowCount,
    payloadShapes: [...shape].map(([keys, count]) => ({ keys, count })),
    dbCounts: counts.rows[0] }));
} finally {
  client.release();
  await pool.end();
}
