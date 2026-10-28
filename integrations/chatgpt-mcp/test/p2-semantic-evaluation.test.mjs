import assert from "node:assert/strict";
import test from "node:test";
import { buildP2SemanticAudit } from "../db/p2-semantic-evaluation.mjs";

const source = { modelAnswer: "청구 요건을 검토한 뒤 결론을 쓴다.",
  rubric: "청구 요건 검토와 결론에 배점한다.", originalAnswer: "청구 요건은 충족된다. 결론은 인용이다." };
const base = {
  elements: [
    { category: "ELEMENT", criterion: "청구 요건", status: "MATCH", modelExcerpt: "청구 요건",
      answerExcerpt: "청구 요건은 충족된다", explanation: "요건 판단이 있다" },
    { category: "CONCLUSION", criterion: "결론", status: "PARTIAL", modelExcerpt: "결론",
      answerExcerpt: "결론은 인용", explanation: "결론은 있으나 근거가 부족하다" },
  ],
  matchedLaw: ["청구 요건"], missingLaw: [], misappliedLaw: [],
  improvement: "결론의 근거를 연결한다", decompositionRationale: "이 표본은 요건과 결론을 요구한다",
  scoreRationale: "공식 기준의 요건·결론 배점을 각각 확인했다",
};

test("P2 audit reports element match separately from official point score", () => {
  const result = buildP2SemanticAudit(base, source);
  assert.deepEqual(result.coreElementMatch, {
    matchedCount: 1, partialCount: 1, missingCount: 0, errorCount: 0,
    totalCount: 2, rate: 0.5,
    formula: "(MATCH + ALTERNATIVE_ACCEPTED) / total elements; partial reported separately",
  });
  assert.ok(!JSON.stringify(result).includes("청구 요건은 충족된다"));
  assert.ok(!JSON.stringify(result).includes("청구 요건을 검토한 뒤"));
  assert.equal(result.elements[0].modelEvidenceDigest.length, 64);
});

test("P2 audit rejects unsupported claims and permits sourced alternative reasoning", () => {
  assert.throws(() => buildP2SemanticAudit({ ...base, elements: [{ ...base.elements[0],
    modelExcerpt: "공식 자료에 없는 법리" }] }, source), /model evidence absent/);
  assert.throws(() => buildP2SemanticAudit({ ...base, elements: [{ ...base.elements[0],
    answerExcerpt: "사용자 원답에 없는 문장" }] }, source), /answer evidence absent/);
  assert.throws(() => buildP2SemanticAudit({ ...base, elements: [{ ...base.elements[0],
    status: "ALTERNATIVE_ACCEPTED" }] }, source), /source reference/);
  const alternative = buildP2SemanticAudit({ ...base, elements: [{ ...base.elements[0],
    status: "ALTERNATIVE_ACCEPTED", alternativeSourceRef: "검증된 판례 식별자" }] }, source);
  assert.equal(alternative.coreElementMatch.rate, 1);
});

test("P2 audit cannot call missing evidence a full match", () => {
  assert.throws(() => buildP2SemanticAudit({ ...base, elements: [{ ...base.elements[0],
    answerExcerpt: "" }] }, source), /answer evidence\/status mismatch/);
  const missing = buildP2SemanticAudit({ ...base, elements: [{ ...base.elements[0],
    status: "MISSING", answerExcerpt: "" }] }, source);
  assert.equal(missing.coreElementMatch.rate, 0);
});
