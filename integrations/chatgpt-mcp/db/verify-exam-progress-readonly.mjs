// Railway read-only smoke check. Output aggregates only: no user identifiers or answers.
import pg from "pg";
import { postgresConnectionOptions } from "./pg-connection.mjs";
import { getExamProgress } from "./exam-progress.mjs";

const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool(postgresConnectionOptions(connectionString, { max: 4 }));
try {
  const owner = await pool.query(`SELECT owner_id FROM issue_sets WHERE subject_id='CIVIL'
    GROUP BY owner_id ORDER BY count(*) DESC LIMIT 1`);
  if (owner.rowCount !== 1) throw new Error("no test owner available");
  const result = await getExamProgress(pool, { ownerId: owner.rows[0].owner_id, limit: 10 });
  const pendingOwner = await pool.query(`SELECT s.owner_id,a.stable_key FROM submissions s
    JOIN issue_sets sets ON sets.set_id=s.set_id AND sets.stage='P2'
    JOIN original_answers a ON a.submission_id=s.submission_id
    WHERE s.subject_id='CIVIL' AND s.state='PREPARED'
      AND length(btrim(a.answer_text))>0 LIMIT 1`);
  const pendingProgress = pendingOwner.rowCount
    ? await getExamProgress(pool, { ownerId: pendingOwner.rows[0].owner_id, stage: 'P2', limit: 1 })
    : null;
  let pendingPageStatusVerified = false;
  if (pendingOwner.rowCount) {
    let cursor;
    do {
      const page = await getExamProgress(pool, { ownerId: pendingOwner.rows[0].owner_id,
        stage: 'P2', cursor, limit: 100 });
      const item = page.items.find(row => row.stableKey === pendingOwner.rows[0].stable_key);
      if (item) pendingPageStatusVerified = item.historyStatus === 'pending_grade'
        && item.mastery === '확인 필요' && item.hasPendingOriginal === true;
      cursor = page.nextCursor;
    } while (cursor && !pendingPageStatusVerified);
  }
  const steps = await pool.query(`SELECT migration_name FROM schema_migrations
    WHERE migration_name IN ('0008_exam_selection_indexes.sql','0009_exam_review_due.sql')
    ORDER BY migration_name`);
  const due = await pool.query("SELECT count(*)::int AS count FROM exam_review_due");
  process.stdout.write(JSON.stringify({ readOnly: true, items: result.items.length,
    overallStatus: result.overallStatus,
    ambiguous: result.items.filter((item) => item.historyStatus === "ambiguous").length,
    pendingOwnerUnknownItems: pendingProgress?.totals.find(row => row.stage === 'P2')?.unknown ?? 0,
    pendingPageStatusVerified,
    schemaSteps: steps.rows.map((row) => row.migration_name), dueRows: due.rows[0].count }));
} finally {
  await pool.end();
}
