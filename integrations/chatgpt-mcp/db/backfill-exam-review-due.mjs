import pg from "pg";

import { postgresConnectionOptions } from "./pg-connection.mjs";

const HISTORY = `WITH raw AS (
  SELECT s.owner_id,g.subject_id,g.stable_key,s.submission_id,s.committed_at,
         (s.state='COMMITTED' AND s.committed_at IS NOT NULL AND sets.stage='P1'
           AND p.stage='P1' AND sets.owner_id=s.owner_id
           AND s.subject_id=g.subject_id AND sets.subject_id=g.subject_id
           AND EXISTS (SELECT 1 FROM original_answers answer
             WHERE answer.submission_id=g.submission_id AND answer.stable_key=g.stable_key
               AND length(btrim(answer.answer_text))>0)) AS valid
    FROM p1_grades g JOIN submissions s ON s.submission_id=g.submission_id
    JOIN issue_sets sets ON sets.set_id=s.set_id
    JOIN problems p ON p.subject_id=g.subject_id AND p.stable_key=g.stable_key
  UNION ALL
  SELECT s.owner_id,g.subject_id,g.stable_key,s.submission_id,s.committed_at,
         (s.state='COMMITTED' AND s.committed_at IS NOT NULL AND sets.stage='P2'
           AND p.stage='P2' AND sets.owner_id=s.owner_id
           AND s.subject_id=g.subject_id AND sets.subject_id=g.subject_id) AS valid
    FROM p2_grades g JOIN submissions s ON s.submission_id=g.submission_id
    JOIN issue_sets sets ON sets.set_id=s.set_id
    JOIN problems p ON p.subject_id=g.subject_id AND p.stable_key=g.stable_key
   WHERE EXISTS (SELECT 1 FROM original_answers answer
     WHERE answer.submission_id=g.submission_id AND answer.stable_key=g.stable_key
       AND length(btrim(answer.answer_text))>0)
), summary AS (
  SELECT owner_id,subject_id,stable_key,count(*) AS attempt_count,
         count(DISTINCT submission_id) AS distinct_attempts,bool_and(valid) AS all_valid,
         max(committed_at) AS latest_at
    FROM raw GROUP BY owner_id,subject_id,stable_key
), verified AS (
  SELECT s.owner_id,s.subject_id,s.stable_key,s.attempt_count,s.latest_at,
         (array_agg(r.submission_id))[1] AS latest_submission_id
    FROM summary s JOIN raw r
      ON r.owner_id=s.owner_id AND r.subject_id=s.subject_id AND r.stable_key=s.stable_key
     AND r.committed_at=s.latest_at
   WHERE s.all_valid AND s.attempt_count=s.distinct_attempts
   GROUP BY s.owner_id,s.subject_id,s.stable_key,s.attempt_count,s.latest_at
  HAVING count(*)=1
)`;

const INVENTORY = `${HISTORY}
SELECT (SELECT count(*)::int FROM summary) AS history_groups,
       (SELECT count(*)::int FROM verified) AS verified_groups,
       (SELECT count(*)::int FROM verified v LEFT JOIN exam_review_due d
         ON d.owner_id=v.owner_id AND d.subject_id=v.subject_id AND d.stable_key=v.stable_key
         WHERE d.owner_id IS NULL) AS missing_due_groups`;

const INSERT = `${HISTORY}
INSERT INTO exam_review_due(owner_id,subject_id,stable_key,due_at,review_step,last_submission_id)
SELECT owner_id,subject_id,stable_key,
       latest_at + CASE WHEN attempt_count=1 THEN interval '7 days'
                        WHEN attempt_count=2 THEN interval '21 days'
                        ELSE interval '60 days' END,
       LEAST(attempt_count-1,2)::smallint,latest_submission_id
  FROM verified WHERE true
ON CONFLICT(owner_id,subject_id,stable_key) DO NOTHING`;

/** Dry-run by default. The apply flag inserts only unambiguous missing schedule rows. */
export async function backfillExamReviewDue(pool, { apply = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query(apply ? "BEGIN ISOLATION LEVEL REPEATABLE READ" : "BEGIN READ ONLY");
    if (apply) await client.query("SELECT pg_advisory_xact_lock(hashtext('exam-review-due-backfill'))");
    const before = (await client.query(INVENTORY)).rows[0];
    const inserted = apply ? (await client.query(INSERT)).rowCount : 0;
    const after = apply ? (await client.query(INVENTORY)).rows[0] : before;
    await client.query("COMMIT");
    return { ok: true, applied: apply, historyGroups: Number(before.history_groups),
      verifiedGroups: Number(before.verified_groups),
      ambiguousGroups: Number(before.history_groups) - Number(before.verified_groups),
      missingBefore: Number(before.missing_due_groups), inserted,
      missingAfter: Number(after.missing_due_groups) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1]?.endsWith("backfill-exam-review-due.mjs")) {
  const apply = process.argv.includes("--apply");
  if (apply && (process.env.EXAM_REVIEW_BACKFILL_TEST_ONLY !== "true" ||
      !process.argv.includes("--independent-test-db"))) {
    throw new Error("test-only backfill requires explicit guard");
  }
  const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool(postgresConnectionOptions(connectionString, { max: 1 }));
  try {
    process.stdout.write(JSON.stringify(await backfillExamReviewDue(pool, { apply })) + "\n");
  } catch (error) {
    process.stderr.write(`backfill failed: ${error.name || "Error"}\n`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
