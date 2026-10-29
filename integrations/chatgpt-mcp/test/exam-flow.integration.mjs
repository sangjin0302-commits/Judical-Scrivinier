// Disposable localhost PostgreSQL only. Never point at Railway or user data.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import pg from "pg";

import { createPostgresExecutor, gradingAad } from "../db/postgres-adapter.mjs";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL required");
const target = new URL(url);
if (!["127.0.0.1", "localhost"].includes(target.hostname) || target.port !== "55432" ||
    !/^exam_flow_[a-z0-9_]+$/i.test(target.pathname.slice(1))) {
  throw new Error("integration test requires disposable localhost exam_flow_* database");
}

const pool = new pg.Pool({ connectionString: url, max: 2 });
const encryptionKey = crypto.randomBytes(32);
const keyId = "synthetic-flow-key";
const ownerId = "synthetic-workos-user";
const p1Keys = ["SRC-CIV-004|SYNTH-FLOW-1", "SRC-CIV-004|SYNTH-FLOW-2"];
const p2Keys = ["SRC-CIV-005|2025-제1회-문8-소문항1", "SRC-CIV-005|2025-제1회-문8-소문항2"];
const migration = (name) => readFile(new URL(`../db/migrations/${name}`, import.meta.url), "utf8");
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

function encryptedKey(stableKey, payload) {
  const text = JSON.stringify(payload);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
  cipher.setAAD(gradingAad("CIVIL", stableKey, "v1", keyId));
  const body = Buffer.concat([cipher.update(text), cipher.final()]);
  return { encrypted: Buffer.concat([iv, cipher.getAuthTag(), body]), payloadDigest: digest(text) };
}

async function addProblem(stableKey, stage, sourceOrder, answer, maxPoints = null) {
  const prompt = `Synthetic ${stage} ${sourceOrder}`;
  await pool.query(`INSERT INTO problems(subject_id,stable_key,stage,source_order,source_ref,
    source_version,prompt_text,max_points,published,content_digest)
    VALUES('CIVIL',$1,$2,$3,'synthetic','v1',$4,$5,true,$6)`,
  [stableKey, stage, sourceOrder, prompt, maxPoints, digest(stableKey)]);
  const version = await pool.query(`INSERT INTO problem_versions(subject_id,stable_key,
    source_document_id,source_revision_id,source_version,stage,source_order,prompt_text,
    max_points,prompt_digest) VALUES('CIVIL',$1,'synthetic-doc','r1','v1',$2,$3,$4,$5,$6)
    RETURNING version_id`, [stableKey, stage, sourceOrder, prompt, maxPoints, digest(prompt)]);
  await pool.query(`UPDATE problems SET current_problem_version_id=$1
    WHERE subject_id='CIVIL' AND stable_key=$2`, [version.rows[0].version_id, stableKey]);
  const { encrypted, payloadDigest } = encryptedKey(stableKey, { answer,
    rubric: "요건과 결론을 확인한다.", rationale: "합성 시험 전용" });
  await pool.query(`INSERT INTO private_grading_keys(subject_id,stable_key,key_version,
    encrypted_payload,payload_digest,encryption_key_id,verification_state,active_for_grading)
    VALUES('CIVIL',$1,'v1',$2,$3,$4,'verified',true)`,
  [stableKey, encrypted, payloadDigest, keyId]);
}

const semantic = (answerExcerpt, status) => ({
  elements: [{ category: "ELEMENT", criterion: "요건", status,
    modelExcerpt: "요건", ...(answerExcerpt ? { answerExcerpt } : {}),
    explanation: status === "MISSING" ? "원답에 요건 없음" : "원답에 요건 있음" }],
  matchedLaw: status === "MISSING" ? [] : ["요건"],
  missingLaw: status === "MISSING" ? ["요건"] : [], misappliedLaw: [],
  improvement: "요건과 결론을 분명히 적는다", decompositionRationale: "모범답안의 요건을 한 요소로 추출",
  scoreRationale: "필수 의미요소 비율로 계산",
});
const scores = (value) => Object.fromEntries(
  ["issue", "outline", "law", "precedent", "application", "conclusion", "expression"]
    .map((name) => [name, value]));
const summary = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (rate) => Number(sorted[Math.ceil(sorted.length * rate) - 1].toFixed(3));
  return { count: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95) };
};

try {
  const existing = await pool.query("SELECT to_regclass('public.problems') AS problems");
  if (existing.rows[0].problems) throw new Error("disposable database must be empty");
  for (const name of ["0001_learning_ledger.sql", "0002_grading_key_rotation.sql",
    "0004_google_docs_sync.sql", "0008_exam_selection_indexes.sql", "0009_exam_review_due.sql"]) {
    await pool.query(await migration(name));
  }
  await pool.query("INSERT INTO subjects(subject_id,name) VALUES('CIVIL','Synthetic civil')");
  await pool.query(`INSERT INTO source_documents(document_id,subject_id,title)
    VALUES('synthetic-doc','CIVIL','Synthetic isolated document')`);
  await pool.query(`INSERT INTO document_revisions(document_id,revision_id,content_digest,
    parser_version,parsed_problem_count)
    VALUES('synthetic-doc','r1','synthetic-digest','test-v1',4)`);
  await addProblem(p1Keys[0], "P1", 1, "O");
  await addProblem(p1Keys[1], "P1", 2, "X");
  await addProblem(p2Keys[0], "P2", 3, "요건을 충족한다.", 15);
  await addProblem(p2Keys[1], "P2", 4, "요건을 충족한다.", 15);
  const execute = createPostgresExecutor({ pool, env: {
    GRADING_KEY_BASE64: encryptionKey.toString("base64"), GRADING_ENCRYPTION_KEY_ID: keyId,
    P2_GRADE_COMMIT_ENABLED: "true",
  } });
  const context = { ownerId };
  const p1 = await execute("issueCivilP1", { requestId: "synthetic-p1-1", mode: "문제지정",
    count: 2, specificKeys: p1Keys }, context);
  assert.equal(p1.count, 2);
  assert.deepEqual(p1.questions.map((item) => item.key), p1Keys);
  assert.equal(JSON.stringify(p1).includes("요건을 충족한다"), false);
  const p1Grade = await execute("gradeCivilP1", { setId: p1.setId, answers: ["O", "X"] }, context);
  assert.equal(p1Grade.correct, 2);
  assert.equal((await execute("gradeCivilP1", { setId: p1.setId, answers: ["O", "X"] }, context)).replayed, true);
  await assert.rejects(execute("gradeCivilP1", { setId: p1.setId, answers: ["X", "X"] }, context),
    /changed answer payload rejected/);
  await assert.rejects(execute("gradeCivilP1", { setId: p1.setId, answers: ["O", "X"] },
    { ownerId: "another-user" }), /ownership denied/);

  const p2 = await execute("issueCivilP2", { requestId: "synthetic-p2-1", mode: "문제지정",
    caseCount: 1, specificKeys: [p2Keys[0]] }, context);
  assert.equal(p2.caseCount, 1);
  assert.deepEqual(p2.questions.map((item) => item.key), p2Keys);
  const answers = [{ key: p2Keys[0], text: "요건을 충족한다." }];
  const prepared = await execute("prepareCivilP2Grade", { setId: p2.setId, answers }, context);
  assert.equal(prepared.rubrics.length, 2);
  assert.deepEqual(prepared.subquestions.map((item) => item.submissionStatus),
    ["SUBMITTED", "UNSUBMITTED"]);
  assert.equal((await execute("prepareCivilP2Grade", { setId: p2.setId, answers }, context)).replayed, true);
  await assert.rejects(execute("prepareCivilP2Grade", { setId: p2.setId,
    answers: [{ ...answers[0], text: "changed" }] }, context), /changed answer payload rejected/);
  const evaluations = [{ key: p2Keys[0], maxPoints: 15, scores: scores(1),
    errorType: "none", checkType: "synthetic", nextReview: "none",
    semanticAnalysis: semantic("요건을 충족한다.", "MATCH") },
  { key: p2Keys[1], maxPoints: 15, scores: scores(0),
    errorType: "none", checkType: "synthetic", nextReview: "none",
    semanticAnalysis: semantic("", "MISSING") }];
  const committed = await execute("commitCivilP2Grade", { setId: p2.setId, evaluations }, context);
  assert.deepEqual(committed.summaries.map((item) => item.awardedPoints), [15, 0]);
  assert.equal((await execute("commitCivilP2Grade", { setId: p2.setId, evaluations }, context)).replayed, true);
  await assert.rejects(execute("commitCivilP2Grade", { setId: p2.setId,
    evaluations: [{ ...evaluations[0], awardedPoints: 0 }, evaluations[1]] }, context),
  /changed evaluation payload rejected/);
  const originals = await pool.query("SELECT count(*)::int AS n FROM original_answers");
  const grades = await pool.query("SELECT count(*)::int AS n FROM p2_grades");
  assert.equal(originals.rows[0].n, 3);
  assert.equal(grades.rows[0].n, 2);
  const initialDue = await pool.query(`SELECT stable_key FROM exam_review_due
    WHERE owner_id=$1 AND stable_key=ANY($2::text[]) ORDER BY stable_key`, [ownerId, p2Keys]);
  assert.deepEqual(initialDue.rows.map((item) => item.stable_key), [p2Keys[0]]);
  const timings = { p1Issue: [], p1Grade: [], p2Issue: [], p2Prepare: [], p2Commit: [] };
  for (let index = 0; index < 12; index++) {
    let start = performance.now();
    const p1Sample = await execute("issueCivilP1", { requestId: `bench-p1-${index}`,
      mode: "문제지정", count: 2, specificKeys: p1Keys }, context);
    timings.p1Issue.push(performance.now() - start);
    start = performance.now();
    await execute("gradeCivilP1", { setId: p1Sample.setId, answers: ["O", "X"] }, context);
    timings.p1Grade.push(performance.now() - start);
    start = performance.now();
    const p2Sample = await execute("issueCivilP2", { requestId: `bench-p2-${index}`,
      mode: "문제지정", caseCount: 1, specificKeys: [p2Keys[0]] }, context);
    timings.p2Issue.push(performance.now() - start);
    start = performance.now();
    await execute("prepareCivilP2Grade", { setId: p2Sample.setId, answers }, context);
    timings.p2Prepare.push(performance.now() - start);
    start = performance.now();
    await execute("commitCivilP2Grade", { setId: p2Sample.setId, evaluations }, context);
    timings.p2Commit.push(performance.now() - start);
  }
  const finalDue = await pool.query(`SELECT stable_key FROM exam_review_due
    WHERE owner_id=$1 AND stable_key=ANY($2::text[]) ORDER BY stable_key`, [ownerId, p2Keys]);
  assert.deepEqual(finalDue.rows.map((item) => item.stable_key), [p2Keys[0]]);
  process.stdout.write(JSON.stringify({ ok: true, p1Issued: 2, p1Correct: 2,
    p2CaseItems: 2, p2LearningScores: [15, 0], originalAnswers: 3,
    p2Grades: 2, replayed: true, ownerDenied: true, changedAnswerDenied: true,
    unsubmittedSubquestionHasNoReviewAttempt: true,
    syntheticLocalLatency: Object.fromEntries(Object.entries(timings)
      .map(([name, values]) => [name, summary(values)])) }) + "\n");
} finally {
  await pool.end();
}
