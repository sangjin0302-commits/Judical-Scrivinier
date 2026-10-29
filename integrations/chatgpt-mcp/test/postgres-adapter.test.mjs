import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { createPostgresExecutor, decryptGradingPayload, gradingAad, gradingKey } from "../db/postgres-adapter.mjs";

test("grading key is never generated when the configured key is missing", () => {
  assert.throws(() => gradingKey({}), /GRADING_KEY_BASE64 is required/);
  assert.throws(() => gradingKey({ GRADING_KEY_BASE64: Buffer.alloc(31).toString("base64") }), /32 bytes/);
});

test("new issue sets snapshot exact grading key version and encryption key id", async () => {
  const itemInserts = [];
  const advisoryLocks = [];
  const candidates = Array.from({ length: 10 }, (_, index) => ({
    stable_key: `p-${index + 1}`,
    prompt_text: `question ${index + 1}`,
    max_points: null,
    source_version: "source-v1",
    selection_metadata: {},
    grading_key_version: "source-v1",
    grading_encryption_key_id: "key-v2",
  }));
  const client = {
    async query(sql, values = []) {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rowCount: 0, rows: [] };
      if (sql.includes("pg_advisory_xact_lock")) advisoryLocks.push(values[0]);
      if (sql.includes("FROM issue_sets") && sql.includes("request_id")) return { rowCount: 0, rows: [] };
      if (sql.includes("FROM problems p JOIN private_grading_keys")) return { rowCount: 10, rows: candidates };
      if (sql.includes("INSERT INTO issue_set_items")) itemInserts.push(values);
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const execute = createPostgresExecutor({
    pool: { connect: async () => client },
    env: { GRADING_ENCRYPTION_KEY_ID: "key-v2" },
  });
  const result = await execute("issueCivilP1", { requestId: "snapshot-1", mode: "전범위" }, { ownerId: "user-1" });
  assert.equal(result.count, 10);
  assert.equal(itemInserts.length, 10);
  assert.equal(advisoryLocks.length, 1);
  assert.match(advisoryLocks[0], /^[0-9a-f]{64}$/);
  assert.ok(itemInserts.every((values) => values[4] === "source-v1" && values[5] === "key-v2"));
});

test("AES-256-GCM payloads decrypt only with the transferred key", () => {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const aad = gradingAad("CIVIL", "problem-1", "source-v1", "key-v2");
  const plaintext = JSON.stringify({ answer: "O" });
  const payloadDigest = crypto.createHash("sha256").update(plaintext).digest("hex");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const encrypted = Buffer.concat([iv, cipher.getAuthTag(), body]);
  assert.deepEqual(decryptGradingPayload(encrypted, key, aad, payloadDigest), { answer: "O" });
  assert.throws(() => decryptGradingPayload(encrypted, crypto.randomBytes(32), aad, payloadDigest));
  assert.throws(() => decryptGradingPayload(encrypted, key,
    gradingAad("CIVIL", "problem-2", "source-v1", "key-v2"), payloadDigest));
  assert.throws(() => decryptGradingPayload(encrypted, key, aad, "0".repeat(64)), /digest mismatch/);
});

test("P2 commit validates official and original evidence before any grade write", async () => {
  const key = crypto.randomBytes(32);
  const source = { answer: "요건을 검토한다.", rubric: "요건에 배점한다." };
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
          max_points: 10, source_version: "v1" }] };
      if (sql.includes("FROM submissions")) return { rowCount: 1, rows: [
        { submission_id: "submission-1", state: committedDigest ? "COMMITTED" : "PREPARED",
          grade_digest: committedDigest }] };
      if (sql.includes("FROM private_grading_keys")) return { rowCount: 1, rows: [
        { key_version: "v1", encryption_key_id: "key-v1", encrypted_payload: encrypted,
          payload_digest: crypto.createHash("sha256").update(plaintext).digest("hex") }] };
      if (sql.includes("FROM original_answers")) return { rowCount: 1, rows: [
        { stable_key: "p2-1", answer_text: originalAnswer }] };
      if (sql.includes("INSERT INTO p2_grades")) storedPayload = JSON.parse(values[15]);
      if (sql.includes("UPDATE submissions SET grade_digest")) committedDigest = values[0];
      if (sql.includes("FROM p2_grades")) return { rowCount: 1, rows: [
        { stable_key: "p2-1", awarded_points: 5, max_points: 10, evaluation_payload: storedPayload }] };
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const executor = createPostgresExecutor({ pool: { connect: async () => client },
    env: { GRADING_KEY_BASE64: key.toString("base64"), GRADING_ENCRYPTION_KEY_ID: "key-v1" } });
  const evaluation = { key: "p2-1", maxPoints: 10, awardedPoints: 5,
    scores: { issue: 1, outline: 1, law: 1, precedent: 0, application: 1, conclusion: 1, expression: 1 },
    errorType: "none", checkType: "review", nextReview: "3 days",
    semanticAnalysis: { elements: [{ category: "ELEMENT", criterion: "요건", status: "MATCH",
      modelExcerpt: "요건", answerExcerpt: "요건이 충족된다", explanation: "요건을 확인했다" }],
      matchedLaw: ["요건"], missingLaw: [], misappliedLaw: [], improvement: "근거를 보강한다",
      decompositionRationale: "공식 자료의 요건을 필수 요소로 추렸다",
      scoreRationale: "공식 요건 배점 기준에 따라 5점을 인정했다" } };
  await assert.rejects(() => executor("commitCivilP2Grade", { setId: "set-1", evaluations: [
    { ...evaluation, semanticAnalysis: { ...evaluation.semanticAnalysis,
      elements: [{ ...evaluation.semanticAnalysis.elements[0], modelExcerpt: "없는 공식 근거" }] } },
  ] }, { ownerId: "user-1" }), /model evidence absent/);
  assert.equal(statements.filter((sql) => sql.includes("INSERT INTO p2_grades")).length, 0);
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
  assert.equal(result.summaries[0].awardedPoints, 5);
  assert.equal(statements.filter((sql) => sql.includes("INSERT INTO p2_grades")).length, 1);
  assert.equal(statements.at(-1), "COMMIT");
  statements.length = 0;
  const replay = await executor("commitCivilP2Grade", { setId: "set-1", evaluations: [evaluation] },
    { ownerId: "user-1" });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.summaries[0].coreElementMatch, result.summaries[0].coreElementMatch);
  assert.equal(statements.filter((sql) => sql.includes("INSERT INTO p2_grades")).length, 0);
});
