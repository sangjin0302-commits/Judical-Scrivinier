import assert from "node:assert/strict";
import test from "node:test";
import { buildP2SemanticAudit, calculateP2LearningScore,
  isNonSubstantiveP2Answer } from "../db/p2-semantic-evaluation.mjs";

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
    totalCount: 2, rate: 0.75,
    formula: "(MATCH + ALTERNATIVE_ACCEPTED + 0.5 × PARTIAL) / required elements",
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

test("P2 abstention cannot receive points or a matching legal element", () => {
  const abstention = { ...source, originalAnswer: "모르겠다.", awardedPoints: 0 };
  const missing = { ...base, matchedLaw: [], elements: [{ ...base.elements[0], status: "MISSING", answerExcerpt: "" }] };
  assert.equal(buildP2SemanticAudit(missing, abstention).coreElementMatch.rate, 0);
  assert.throws(() => buildP2SemanticAudit(missing, { ...abstention, awardedPoints: 1 }),
    /cannot earn points/);
  assert.throws(() => buildP2SemanticAudit({ ...base, elements: [{ ...base.elements[0],
    answerExcerpt: "모르겠다" }] }, abstention), /must mark every element missing/);
  assert.throws(() => buildP2SemanticAudit({ ...missing, elements: [{ ...missing.elements[0],
    status: "ERROR", answerExcerpt: "모르겠다" }] }, abstention), /must mark every element missing/);
  assert.throws(() => buildP2SemanticAudit({ ...missing, misappliedLaw: ["가공된 오답"] }, abstention),
    /cannot claim matched or misapplied law/);
});

test("P2 abstention variants remain exact-answer only", () => {
  for (const answer of ["모르겠음", "모르겠다.", "모르겠습니다!", "잘 모르겠습니다", "모름"]) {
    assert.equal(isNonSubstantiveP2Answer(answer), true);
  }
  for (const answer of ["법리는 상대적 효력이다. 결론은 모르겠음", "모르겠습니다만 요건은 충족됩니다."]) {
    assert.equal(isNonSubstantiveP2Answer(answer), false);
  }
});

test("P2 positive points require at least one evidenced legal element", () => {
  const irrelevant = { ...source, originalAnswer: "사안의 결론을 알 수 없다.", awardedPoints: 1 };
  const allMissing = { ...base, elements: [{ ...base.elements[0], status: "MISSING", answerExcerpt: "" }] };
  assert.throws(() => buildP2SemanticAudit(allMissing, irrelevant), /positive points require/);
  const partial = { ...base, elements: [{ ...base.elements[0], status: "PARTIAL",
    answerExcerpt: "사안의 결론을 알 수 없다." }] };
  assert.equal(buildP2SemanticAudit(partial, irrelevant).coreElementMatch.partialCount, 1);
});

test("P2 public precedent fixture keeps equivalent reasoning, error and official score separate", () => {
  // Public primary source: Supreme Court 2012다73158 (2014-12-24).
  // These are infrastructure fixtures, never student performance or an official rubric.
  const publicSource = { modelAnswer: "사해행위취소는 채권자와 수익자 사이에서 상대적으로 효력이 생긴다. 경매 매수인은 관습상 법정지상권을 취득한다.",
    rubric: "상대적 효력, 토지와 건물의 소유 분리, 경매 매수인의 관습상 법정지상권을 검토한다." };
  const cases = [
    { originalAnswer: "취소 판결은 당사자 관계에만 미친다. 병은 관습법상 지상권을 얻는다.",
      status: "MATCH", excerpt: "당사자 관계에만 미친다", rate: 1 },
    { originalAnswer: "취소 판결 효력은 상대적이다. 결론은 모르겠다.",
      status: "PARTIAL", excerpt: "취소 판결 효력은 상대적이다", rate: 0.5 },
    { originalAnswer: "취소 판결로 매매는 절대적으로 소급 무효가 된다.",
      status: "ERROR", excerpt: "절대적으로 소급 무효", rate: 0 },
  ];
  for (const item of cases) {
    const audit = buildP2SemanticAudit({ ...base, elements: [{ category: "LAW", criterion: "사해행위취소의 상대적 효력",
      status: item.status, modelExcerpt: "상대적으로 효력이 생긴다", answerExcerpt: item.excerpt,
      explanation: "공개 판례에 비춰 수동 판정한 시험 입력",
      ...(item.status === "ALTERNATIVE_ACCEPTED" ? { alternativeSourceRef: "대법원 2014.12.24. 선고 2012다73158" } : {}) }] },
    { ...publicSource, originalAnswer: item.originalAnswer, awardedPoints: 0 });
    assert.equal(audit.coreElementMatch.rate, item.rate);
    assert.equal(audit.aiScore, undefined);
  }
  const equivalentExpression = buildP2SemanticAudit({ ...base, elements: [{ category: "CONCLUSION",
    criterion: "경매 매수인의 지상권 취득", status: "MATCH",
    modelExcerpt: "경매 매수인은 관습상 법정지상권을 취득한다",
    answerExcerpt: "건물과 함께 지상권을 넘겨받는다",
    explanation: "공개 판례의 경매 취득 법리를 다른 표현으로 설명" }] },
  { ...publicSource, originalAnswer: "병은 건물과 함께 지상권을 넘겨받는다.", awardedPoints: 0 });
  assert.equal(equivalentExpression.coreElementMatch.rate, 1);
});
