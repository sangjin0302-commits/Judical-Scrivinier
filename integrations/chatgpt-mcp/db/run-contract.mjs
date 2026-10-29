import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!connectionString && process.env.RAILWAY_TEST_TUNNEL !== "1") {
  throw new Error("Railway database URL is unavailable");
}

const root = resolve(import.meta.dirname);
const migration = await readFile(resolve(root, "migrations/0001_learning_ledger.sql"), "utf8");
const contract = (await readFile(resolve(root, "test/transaction_contract.sql"), "utf8"))
  .split(/\r?\n/).filter((line) => !line.trimStart().startsWith("\\")).join("\n");
const connection = process.env.RAILWAY_TEST_TUNNEL === "1" ? {
  host: "127.0.0.1", port: 15432, user: process.env.PGUSER,
  password: process.env.PGPASSWORD, database: process.env.PGDATABASE, ssl: false
} : { connectionString };
const pool = new pg.Pool({ ...connection, max: 4, connectionTimeoutMillis: 15_000 });

async function commitP2(setId, requestId, answerDigest, evaluationDigest) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const set = await client.query("SELECT subject_id FROM issue_sets WHERE set_id=$1 FOR UPDATE", [setId]);
    if (set.rowCount !== 1) throw new Error("set missing");
    const previous = await client.query(
      "SELECT submission_id, answer_digest, grade_digest, state FROM submissions WHERE set_id=$1", [setId]);
    if (previous.rowCount) {
      const row = previous.rows[0];
      if (row.answer_digest !== answerDigest || row.grade_digest !== evaluationDigest) {
        throw new Error("changed payload rejected");
      }
      await client.query("COMMIT");
      return { replayed: true, submissionId: row.submission_id };
    }
    const inserted = await client.query(
      `INSERT INTO submissions(set_id,owner_id,subject_id,request_id,answer_digest,grade_digest)
       VALUES($1,'fixture-user','CIVIL',$2,$3,$4) RETURNING submission_id`,
      [setId, requestId, answerDigest, evaluationDigest]);
    const submissionId = inserted.rows[0].submission_id;
    await client.query(
      `INSERT INTO original_answers(submission_id,subject_id,stable_key,answer_text,answer_digest)
       VALUES($1,'CIVIL','TEST-CIV-P2-001','합성 원답','answer-row')`, [submissionId]);
    await client.query(
      `INSERT INTO p2_grades(submission_id,subject_id,stable_key,awarded_points,max_points,
       issue_score,outline_score,law_score,precedent_score,application_score,conclusion_score,expression_score,
       error_type,check_type,next_review_type,evaluation_payload,evaluation_digest)
       VALUES($1,'CIVIL','TEST-CIV-P2-001',10,20,1,1,1,1,1,1,1,
       '복합 오류','해당없음','사례형 재작성','{"fixture":true}',$2)`, [submissionId, evaluationDigest]);
    await client.query(
      `INSERT INTO sheet_outbox(aggregate_type,aggregate_id,event_type,payload,payload_digest)
       VALUES('submission',$1,'P2_GRADED','{"fixture":true}','outbox-concurrent')`, [submissionId]);
    await client.query(
      "UPDATE submissions SET state='COMMITTED',committed_at=now() WHERE submission_id=$1", [submissionId]);
    await client.query("COMMIT");
    return { replayed: false, submissionId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

try {
  await pool.query(migration);
  await pool.query(contract);

  await pool.query(`
    INSERT INTO subjects(subject_id,name) VALUES('CIVIL','민법'),('REGISTRATION','부동산등기법');
    INSERT INTO units(subject_id,unit_id,title) VALUES
      ('CIVIL','B1-P0040-0047','신의성실·권리남용'),('REGISTRATION','REG-TEST-001','격리 시험');
    INSERT INTO problems(subject_id,stable_key,unit_id,stage,source_order,source_ref,source_version,
      prompt_text,max_points,published,content_digest) VALUES
      ('CIVIL','TEST-CIV-P2-001','B1-P0040-0047','P2',1,'synthetic','v1','합성 사례',20,true,'p2'),
      ('REGISTRATION','TEST-REG-P1-001','REG-TEST-001','P1',1,'synthetic','v1','격리',NULL,true,'reg');
  `);
  const setId = `TEST-P2-${Date.now()}`;
  await pool.query(
    `INSERT INTO issue_sets(set_id,owner_id,subject_id,stage,request_id,request_digest)
     VALUES($1,'fixture-user','CIVIL','P2','concurrent-issue','issue-digest')`, [setId]);
  await pool.query(
    `INSERT INTO issue_set_items(set_id,subject_id,position,stable_key)
     VALUES($1,'CIVIL',1,'TEST-CIV-P2-001')`, [setId]);

  const concurrent = await Promise.all([
    commitP2(setId, "grade-a", "answer-digest", "evaluation-digest"),
    commitP2(setId, "grade-b", "answer-digest", "evaluation-digest")
  ]);
  let changedRejected = false;
  try { await commitP2(setId, "grade-c", "different-answer", "evaluation-digest"); }
  catch (error) { changedRejected = error.message === "changed payload rejected"; }

  const rollbackSetId = `TEST-P2-ROLLBACK-${Date.now()}`;
  await pool.query(
    `INSERT INTO issue_sets(set_id,owner_id,subject_id,stage,request_id,request_digest)
     VALUES($1,'fixture-user','CIVIL','P2','rollback-issue','rollback')`, [rollbackSetId]);
  const rollbackClient = await pool.connect();
  try {
    await rollbackClient.query("BEGIN");
    await rollbackClient.query(
      `INSERT INTO submissions(set_id,owner_id,subject_id,request_id,answer_digest)
       VALUES($1,'fixture-user','CIVIL','rollback-grade','rollback-answer')`, [rollbackSetId]);
    throw new Error("injected failure");
  } catch {
    await rollbackClient.query("ROLLBACK");
  } finally { rollbackClient.release(); }

  const counts = await pool.query(`SELECT
    (SELECT count(*)::int FROM submissions WHERE set_id=$1) submissions,
    (SELECT count(*)::int FROM original_answers oa JOIN submissions s USING(submission_id) WHERE s.set_id=$1) answers,
    (SELECT count(*)::int FROM p2_grades g JOIN submissions s USING(submission_id) WHERE s.set_id=$1) grades,
    (SELECT count(*)::int FROM submissions WHERE set_id=$2) rollback_rows`,
    [setId, rollbackSetId]);
  const result = counts.rows[0];
  if (result.submissions !== 1 || result.answers !== 1 || result.grades !== 1 || result.rollback_rows !== 0) {
    throw new Error("transaction count verification failed");
  }
  if (concurrent.filter((item) => !item.replayed).length !== 1 ||
      concurrent.filter((item) => item.replayed).length !== 1 || !changedRejected) {
    throw new Error("idempotency verification failed");
  }
  process.stdout.write(JSON.stringify({ ok: true, concurrent: { fresh: 1, replayed: 1 },
    changedRejected, rollbackRows: 0, records: result }));
} finally {
  await pool.end();
}
