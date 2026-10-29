import assert from "node:assert/strict";
import test from "node:test";

import { buildP2SemanticAudit, calculateP2LearningScore } from "../db/p2-semantic-evaluation.mjs";

const criteria = [
  ["ISSUE", "쟁점 식별", "쟁점을 제시한다"],
  ["ELEMENT", "요건 검토", "요건을 검토한다"],
  ["APPLICATION", "사안 포섭", "사실을 요건에 적용한다"],
  ["CONCLUSION", "결론 제시", "결론을 제시한다"],
];
const source = { modelAnswer: criteria.map((entry) => entry[2]).join(" "), rubric: "네 필수 요소를 확인한다." };

function evaluation(statuses, maxPoints = 10) {
  const evidence = statuses.map((status, index) => status === "MISSING" ? "" : `${index}번 답안 ${status}`);
  const originalAnswer = evidence.filter(Boolean).join(". ") || "모르겠다";
  const analysis = { elements: statuses.map((status, index) => ({
    category: criteria[index][0], criterion: criteria[index][1], modelExcerpt: criteria[index][2],
    status, answerExcerpt: evidence[index], explanation: `시험 입력 ${status}`,
    ...(status === "ALTERNATIVE_ACCEPTED" ? { alternativeSourceRef: "공식 기준과 동등한 표현 검토 기록" } : {}),
  })), matchedLaw: [], missingLaw: [], misappliedLaw: [], improvement: "빠진 요소를 보완한다",
  decompositionRationale: "합성 공식 기준의 서로 다른 네 필수 요소", scoreRationale: "비율 계산 확인" };
  return buildP2SemanticAudit(analysis, { ...source, originalAnswer, maxPoints });
}

test("official-model element ratio uses full, partial, zero and no seven-element weights", () => {
  const elements = [...Array(8).fill({ status: "MATCH" }), { status: "PARTIAL" },
    { status: "ERROR" }];
  const score = calculateP2LearningScore(elements, 15);
  assert.equal(score.earnedHalfUnits, 17);
  assert.equal(score.totalHalfUnits, 20);
  assert.equal(score.rawPoints, 12.75);
  assert.equal(score.displayedPoints, 12.75);
  assert.equal(score.displayedText, "12.75");
  assert.equal(score.label, "AI 학습평가 점수 (공식 채점자 점수 아님)");
  assert.equal(score.rawFraction, "25500/2000");
});

test("six answer qualities receive deterministic distinct ratio scores", () => {
  const cases = [
    { name: "complete", statuses: ["MATCH", "MATCH", "MATCH", "MATCH"], score: 10 },
    { name: "equivalent wording", statuses: ["ALTERNATIVE_ACCEPTED", "MATCH", "MATCH", "MATCH"], score: 10 },
    { name: "partial", statuses: ["MATCH", "PARTIAL", "MISSING", "MATCH"], score: 6.25 },
    { name: "right conclusion wrong application", statuses: ["MATCH", "MATCH", "ERROR", "MATCH"], score: 7.5 },
    { name: "opposite law", statuses: ["MATCH", "ERROR", "ERROR", "ERROR"], score: 2.5 },
    { name: "no answer", statuses: ["MISSING", "MISSING", "MISSING", "MISSING"], score: 0 },
  ];
  for (const item of cases) {
    const first = evaluation(item.statuses);
    const second = evaluation(item.statuses);
    assert.deepEqual(second, first, item.name);
    assert.equal(first.learningScore.displayedPoints, item.score, item.name);
    assert.equal(first.coreElementMatch.rate, item.score / 10, item.name);
    assert.equal(first.elements.length, 4);
  }
});

test("raw score survives two-decimal display and user-supplied score mismatch fails", () => {
  const score = calculateP2LearningScore([{ status: "MATCH" }, { status: "MISSING" },
    { status: "MISSING" }], 10);
  assert.equal(score.rawFraction, "2000/600");
  assert.ok(Math.abs(score.rawPoints - 10 / 3) < 1e-12);
  assert.equal(score.displayedText, "3.33");
  assert.throws(() => calculateP2LearningScore([{ status: "unsupported" }], 10), /status/);
  assert.throws(() => calculateP2LearningScore([{ status: "MATCH" }], 1.001), /maximum/);

  const analysis = { elements: [{ category: "ISSUE", criterion: "쟁점", status: "MATCH",
    modelExcerpt: "쟁점", answerExcerpt: "쟁점", explanation: "일치" }],
    matchedLaw: [], missingLaw: [], misappliedLaw: [], improvement: "유지",
    decompositionRationale: "한 요소", scoreRationale: "비율" };
  assert.throws(() => buildP2SemanticAudit(analysis, { modelAnswer: "쟁점", rubric: "쟁점",
    originalAnswer: "쟁점", maxPoints: 10, awardedPoints: 5 }), /differ from calculated/);
});

test("duplicate required semantic element is rejected across category labels", () => {
  const analysis = { elements: [
    { category: "ISSUE", criterion: "동일 법리", status: "MATCH", modelExcerpt: "법리",
      answerExcerpt: "법리", explanation: "첫째" },
    { category: "LAW", criterion: "동일 법리", status: "MATCH", modelExcerpt: "법리",
      answerExcerpt: "법리", explanation: "둘째" },
  ], matchedLaw: [], missingLaw: [], misappliedLaw: [], improvement: "보완",
  decompositionRationale: "두 요소", scoreRationale: "비율" };
  assert.throws(() => buildP2SemanticAudit(analysis, { modelAnswer: "법리", rubric: "법리",
    originalAnswer: "법리", maxPoints: 10 }), /duplicate semantic element/);
});
