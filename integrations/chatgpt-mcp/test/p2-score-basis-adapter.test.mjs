import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { createPostgresExecutor, decryptGradingPayload, gradingAad, gradingKey } from "../db/postgres-adapter.mjs";

import { syntheticAllocatedScoreItem } from "./fixtures/p2-score-basis.mjs";
test("allocated score basis passes encrypted adapter commit and replay without official maximum", async () => {
  const key = crypto.randomBytes(32);
  const fixture = syntheticAllocatedScoreItem();
  const source = { ...fixture.gradingSource, answer: "요건을 검토한다.", rubric: "요건에 배점한다." };
  const plaintext = JSON.stringify(source);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(gradingAad("CIVIL", "p2-1", "v1", "key-v1"));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const encrypted = Buffer.concat([iv, cipher.getAuthTag(), body]);
  const statements = [];
  let committedDigest;
  let storedPayload;
  let originalAnswer = "요건이 충족된다.";
  const client = {
    async query(sql, values = []) {
      statements.push(sql);
      if (sql.includes("FROM issue_sets") && sql.includes("FOR UPDATE")) return { rowCount: 1, rows: [
        { owner_id: "user-1", subject_id: "CIVIL", stage: "P2" }] };
      if (sql.includes("FROM issue_set_items")) return { rowCount: 1, rows: [
        { stable_key: "p2-1", grading_key_version: "v1", grading_encryption_key_id: "key-v1",
          ...fixture.item, max_points: 7.5, source_version: "v1" }] };
      if (sql.includes("FROM submissions")) return { rowCount: 1, rows: [
        { submission_id: "submission-1", state: committedDigest ? "COMMITTED" : "PREPARED",
          grade_digest: committedDigest }] };
      if (sql.includes("FROM private_grading_keys")) return { rowCount: 1, rows: [
        { stable_key: "p2-1", key_version: "v1", encryption_key_id: "key-v1", encrypted_payload: encrypted,
          payload_digest: crypto.createHash("sha256").update(plaintext).digest("hex") }] };
      if (sql.includes("FROM original_answers")) return { rowCount: 1, rows: [
        { stable_key: "p2-1", answer_text: originalAnswer }] };
      if (sql.includes("INSERT INTO p2_grades")) storedPayload = JSON.parse(values[15]);
      if (sql.includes("UPDATE submissions SET grade_digest")) committedDigest = values[0];
      if (sql.includes("FROM p2_grades")) return { rowCount: 1, rows: [
        { stable_key: "p2-1", awarded_points: 7.5, max_points: 7.5, evaluation_payload: storedPayload }] };
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const executor = createPostgresExecutor({ pool: { connect: async () => client },
    env: { GRADING_KEY_BASE64: key.toString("base64"), GRADING_ENCRYPTION_KEY_ID: "key-v1",
      P2_GRADE_COMMIT_ENABLED: "true", P2_GRADE_COMMIT_ALLOWED_SET_IDS: " set-1 " } });
  const evaluation = { key: "p2-1", maxPoints: 7.5, awardedPoints: 7.5,
    scores: { issue: 1, outline: 1, law: 1, precedent: 0, application: 1, conclusion: 1, expression: 1 },
    errorType: "none", checkType: "review", nextReview: "3 days",
    semanticAnalysis: { elements: [{ category: "ELEMENT", criterion: "요건", status: "MATCH",
      modelExcerpt: "요건", answerExcerpt: "요건이 충족된다", explanation: "요건을 확인했다" }],
      matchedLaw: ["요건"], missingLaw: [], misappliedLaw: [], improvement: "근거를 보강한다",
      decompositionRationale: "공식 자료의 요건을 필수 요소로 추렸다",
      scoreRationale: "모범답안의 필수 요건을 모두 인정했다" } };
  await assert.rejects(() => executor("commitCivilP2Grade", { setId: "set-1", evaluations: [
    { ...evaluation, semanticAnalysis: { ...evaluation.semanticAnalysis,
      elements: [{ ...evaluation.semanticAnalysis.elements[0], modelExcerpt: "없는 공식 근거" }] } },
  ] }, { ownerId: "user-1" }), /model evidence absent/);
  assert.equal(statements.filter((sql) => sql.includes("INSERT INTO p2_grades")).length, 0);
  assert.equal(statements.filter((sql) => sql.includes("INSERT INTO exam_review_due")).length, 0);
  assert.equal(statements.at(-1), "ROLLBACK");
  statements.length = 0;
  await assert.rejects(() => executor("commitCivilP2Grade", { setId: "set-1", evaluations: [
    { ...evaluation, scores: { ...evaluation.scores, precedent: 2.5 } },
  ] }, { ownerId: "user-1" }), /invalid P2 seven-element scores/);
  assert.equal(statements.filter((sql) => sql.includes("INSERT INTO p2_grades")).length, 0);
  assert.equal(statements.at(-1), "ROLLBACK");
  statements.length = 0;
  originalAnswer = "모르겠다.";
  await assert.rejects(() => executor("commitCivilP2Grade", { setId: "set-1", evaluations: [
    { ...evaluation, awardedPoints: 0, scores: { ...evaluation.scores, issue: 1 } },
  ] }, { ownerId: "user-1" }), /non-substantive answer cannot earn seven-element credit/);
  assert.equal(statements.filter((sql) => sql.includes("INSERT INTO p2_grades")).length, 0);
  assert.equal(statements.at(-1), "ROLLBACK");
  originalAnswer = "요건이 충족된다.";
  statements.length = 0;
  const result = await executor("commitCivilP2Grade", { setId: "set-1", evaluations: [evaluation] },
    { ownerId: "user-1" });
  assert.equal(result.summaries[0].coreElementMatch.rate, 1);
  assert.equal(result.summaries[0].awardedPoints, 7.5);
  assert.equal(result.summaries[0].learningScore.rawPoints, 7.5);
  assert.equal(statements.filter((sql) => sql.includes("INSERT INTO p2_grades")).length, 1);
  assert.equal(statements.filter((sql) => sql.includes("INSERT INTO exam_review_due")).length, 1);
  assert.equal(statements.at(-1), "COMMIT");
  statements.length = 0;
  assert.equal(Object.hasOwn(storedPayload.aiScore, "officialMaximum"), false);
  assert.equal(storedPayload.aiScore.learningMaximum, 7.5);
  assert.equal(storedPayload.aiScore.originalGroupMaximum, 15);
  const replay = await executor("commitCivilP2Grade", { setId: "set-1", evaluations: [evaluation] },
    { ownerId: "user-1" });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.summaries[0].coreElementMatch, result.summaries[0].coreElementMatch);
  assert.equal(statements.filter((sql) => sql.includes("INSERT INTO p2_grades")).length, 0);
  assert.equal(statements.filter((sql) => sql.includes("INSERT INTO exam_review_due")).length, 0);
});
