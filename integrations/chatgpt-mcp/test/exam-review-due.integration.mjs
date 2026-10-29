// Disposable localhost PostgreSQL only. Never point this script at Railway.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";

import { backfillExamReviewDue } from "../db/backfill-exam-review-due.mjs";
import { scheduleExamReviewDue } from "../db/postgres-adapter.mjs";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL required");
const target = new URL(url);
if (!["127.0.0.1", "localhost"].includes(target.hostname) || target.port !== "55432" ||
    !/^exam_review_[a-z0-9_]+$/i.test(target.pathname.slice(1))) {
  throw new Error("integration test requires disposable local exam_review_* database on port 55432");
}
const pool = new pg.Pool({ connectionString: url, max: 2 });
const q = (sql, params) => pool.query(sql, params);
const migration = (name) => readFile(new URL(`../db/migrations/${name}`, import.meta.url), "utf8");
const key = "SRC-CIV-004|SYNTH-REVIEW-1";

async function createSubmission(number, client, stage = "P1") {
  const setId = `SYNTH-REVIEW-SET-${number}`;
  await client.query(`INSERT INTO issue_sets(set_id,owner_id,subject_id,stage,request_id,request_digest,state)
    VALUES($1,'synthetic-owner','CIVIL',$2,$3,'synthetic-digest','COMMITTED')`,
    [setId, stage, `synthetic-request-${number}`]);
  const result = await client.query(`INSERT INTO submissions(set_id,owner_id,subject_id,request_id,answer_digest,
      state,committed_at) VALUES($1,'synthetic-owner','CIVIL',$2,'synthetic-answer-digest',
      'COMMITTED',now()) RETURNING submission_id`, [setId, `synthetic-grade-${number}`]);
  return result.rows[0].submission_id;
}

async function state(client) {
  const result = await client.query(`SELECT review_step,last_submission_id,
      extract(epoch FROM due_at-now())/86400 AS days_remaining
    FROM exam_review_due WHERE owner_id='synthetic-owner' AND subject_id='CIVIL' AND stable_key=$1`, [key]);
  return result.rows[0];
}

try {
  const existing = await q("SELECT to_regclass('public.problems') AS problems");
  if (existing.rows[0].problems) throw new Error("disposable database must be empty");
  for (const name of ["0001_learning_ledger.sql", "0002_grading_key_rotation.sql",
    "0009_exam_review_due.sql"]) await q(await migration(name));
  await q("INSERT INTO subjects(subject_id,name) VALUES('CIVIL','Synthetic civil exam')");
  await q(`INSERT INTO problems(subject_id,stable_key,stage,source_order,source_ref,source_version,
    prompt_text,published,content_digest) VALUES('CIVIL',$1,'P1',1,'synthetic','v1',
    'Synthetic OX question',true,'synthetic-digest')`, [key]);

  const client = await pool.connect();
  try {
    const first = await createSubmission(1, client);
    await client.query("BEGIN");
    await scheduleExamReviewDue(client, "synthetic-owner", [key], first);
    await client.query("COMMIT");
    let row = await state(client);
    assert.equal(row.review_step, 0);
    assert.ok(Number(row.days_remaining) > 6.99 && Number(row.days_remaining) <= 7);

    await client.query("BEGIN");
    await scheduleExamReviewDue(client, "synthetic-owner", [key], first);
    await client.query("COMMIT");
    row = await state(client);
    assert.equal(row.review_step, 0);

    const second = await createSubmission(2, client);
    await client.query("BEGIN");
    await scheduleExamReviewDue(client, "synthetic-owner", [key], second);
    await client.query("COMMIT");
    row = await state(client);
    assert.equal(row.review_step, 1);
    assert.ok(Number(row.days_remaining) > 20.99 && Number(row.days_remaining) <= 21);

    const third = await createSubmission(3, client);
    await client.query("BEGIN");
    await scheduleExamReviewDue(client, "synthetic-owner", [key], third);
    await client.query("COMMIT");
    row = await state(client);
    assert.equal(row.review_step, 2);
    assert.ok(Number(row.days_remaining) > 59.99 && Number(row.days_remaining) <= 60);

    const fourth = await createSubmission(4, client);
    await client.query("BEGIN");
    await scheduleExamReviewDue(client, "synthetic-owner", [key], fourth);
    await client.query("ROLLBACK");
    row = await state(client);
    assert.equal(row.review_step, 2);
    assert.equal(String(row.last_submission_id), String(third));
    const original = await client.query("SELECT answer_digest FROM submissions WHERE submission_id=$1", [first]);
    assert.equal(original.rows[0].answer_digest, "synthetic-answer-digest");
    const backfillKey = "SRC-CIV-004|SYNTH-BACKFILL";
    const ambiguousKey = "SRC-CIV-004|SYNTH-AMBIGUOUS";
    for (const [stableKey, sourceOrder] of [[backfillKey, 2], [ambiguousKey, 3]]) {
      await client.query(`INSERT INTO problems(subject_id,stable_key,stage,source_order,source_ref,
        source_version,prompt_text,published,content_digest)
        VALUES('CIVIL',$1,'P1',$2,'synthetic','v1','Synthetic OX question',true,'synthetic-digest')`,
      [stableKey, sourceOrder]);
    }
    const validHistorical = await createSubmission(5, client);
    const ambiguousHistorical = await createSubmission(6, client);
    await client.query(`INSERT INTO original_answers(submission_id,subject_id,stable_key,answer_text,answer_digest)
      VALUES($1,'CIVIL',$2,'O','synthetic'),($3,'CIVIL',$4,'X','synthetic')`,
    [validHistorical, backfillKey, ambiguousHistorical, ambiguousKey]);
    await client.query(`INSERT INTO p1_grades(submission_id,subject_id,stable_key,is_correct,key_version)
      VALUES($1,'CIVIL',$2,false,'v1'),($3,'CIVIL',$4,false,'v1')`,
    [validHistorical, backfillKey, ambiguousHistorical, ambiguousKey]);
    await client.query("UPDATE submissions SET committed_at=NULL WHERE submission_id=$1", [ambiguousHistorical]);
    const placeholderKey = "SRC-CIV-005|2025-제1회-문9-소문항1";
    await client.query(`INSERT INTO problems(subject_id,stable_key,stage,source_order,source_ref,
      source_version,prompt_text,max_points,published,content_digest)
      VALUES('CIVIL',$1,'P2',4,'synthetic','v1','Synthetic case',15,true,'synthetic-digest')`,
    [placeholderKey]);
    const placeholderSubmission = await createSubmission(7, client, "P2");
    await client.query(`INSERT INTO p2_grades(submission_id,subject_id,stable_key,awarded_points,max_points,
      issue_score,outline_score,law_score,precedent_score,application_score,conclusion_score,
      expression_score,error_type,check_type,next_review_type,evaluation_payload,evaluation_digest)
      VALUES($1,'CIVIL',$2,0,15,0,0,0,0,0,0,0,'none','synthetic','none','{}','synthetic')`,
    [placeholderSubmission, placeholderKey]);
    const missingOriginalKey = "SRC-CIV-004|SYNTH-NO-ORIGINAL";
    await client.query(`INSERT INTO problems(subject_id,stable_key,stage,source_order,source_ref,
      source_version,prompt_text,published,content_digest)
      VALUES('CIVIL',$1,'P1',5,'synthetic','v1','Synthetic OX question',true,'synthetic-digest')`,
    [missingOriginalKey]);
    const missingOriginalSubmission = await createSubmission(8, client);
    await client.query(`INSERT INTO p1_grades(submission_id,subject_id,stable_key,is_correct,key_version)
      VALUES($1,'CIVIL',$2,false,'v1')`, [missingOriginalSubmission, missingOriginalKey]);
    const dry = await backfillExamReviewDue(pool);
    assert.equal(dry.historyGroups, 3);
    assert.equal(dry.verifiedGroups, 1);
    assert.equal(dry.ambiguousGroups, 2);
    assert.equal(dry.missingBefore, 1);
    const applied = await backfillExamReviewDue(pool, { apply: true });
    assert.equal(applied.inserted, 1);
    assert.equal(applied.missingAfter, 0);
    assert.equal((await backfillExamReviewDue(pool, { apply: true })).inserted, 0);
    const imported = await client.query(`SELECT stable_key,review_step FROM exam_review_due
      WHERE stable_key=ANY($1::text[]) ORDER BY stable_key`,
    [[backfillKey, ambiguousKey, missingOriginalKey, placeholderKey]]);
    assert.deepEqual(imported.rows.map((item) => item.stable_key), [backfillKey]);
    assert.equal(imported.rows[0].review_step, 0);
    process.stdout.write(JSON.stringify({ ok: true, initial7: true, next21: true,
      next60: true, replayStable: true, rollbackStable: true, originalDigestPreserved: true,
      verifiedBackfillOnly: true, ambiguousHistoryUntouched: true,
      unsubmittedPlaceholderExcluded: true, missingP1OriginalUnverified: true }) + "\n");
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
