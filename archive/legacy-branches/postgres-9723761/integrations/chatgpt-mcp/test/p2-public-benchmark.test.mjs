import assert from "node:assert/strict";
import test from "node:test";
import { buildP2SemanticAudit, isNonSubstantiveP2Answer } from "../db/p2-semantic-evaluation.mjs";

// Public legal gold labels from Supreme Court 2012다73158, not an official exam rubric.
// The analysis below is human-specified test input; this test does not validate AI legal judgment.
const modelAnswer = "채권자취소는 상대적 효력이다. 건물이 채무자에게 직접 복귀하지 않으므로 새 소유자 분리가 없다. 경매 매수인은 해당 토지의 지상권을 취득하지 않는다.";
const anchors = [
  ["LAW", "채권자취소의 상대적 효력", "상대적 효력이다"],
  ["APPLICATION", "취소에 따른 소유 분리 여부", "새 소유자 분리가 없다"],
  ["CONCLUSION", "해당 토지 지상권", "지상권을 취득하지 않는다"],
];
const cases = [
  {
    kind: "complete", answer: "취소는 상대적 효력만 있다. 채무자가 건물을 다시 소유하지 않아 소유자 분리가 없다. 丙은 지상권을 취득하지 않는다.",
    labels: [["MATCH", "상대적 효력만 있다"], ["MATCH", "소유자 분리가 없다"], ["MATCH", "지상권을 취득하지 않는다"]], rate: 1,
  },
  {
    kind: "equivalent", answer: "취소 판결은 당사자 사이에서만 작용한다. 토지와 건물이 새로 갈라진 것은 아니다. 丙에게 X를 쓸 관습법상 권리는 없다.",
    labels: [["MATCH", "당사자 사이에서만 작용한다"], ["MATCH", "새로 갈라진 것은 아니다"], ["MATCH", "관습법상 권리는 없다"]], rate: 1,
  },
  {
    kind: "partial", answer: "취소는 상대적 효력이다. 그 밖은 모르겠다.",
    labels: [["MATCH", "상대적 효력이다"], ["MISSING", ""], ["MISSING", ""]], rate: 1 / 3,
  },
  {
    kind: "right-conclusion-wrong-law", answer: "경매는 모든 지상권을 소멸시킨다. 그러므로 丙은 지상권을 취득하지 않는다.",
    labels: [["ERROR", "모든 지상권을 소멸시킨다"], ["MISSING", ""], ["MATCH", "지상권을 취득하지 않는다"]], rate: 1 / 3,
  },
  {
    kind: "wrong-application", answer: "취소는 상대적 효력이다. 그래도 甲이 건물을 다시 소유하여 토지와 건물이 갈라진다. 丙은 지상권을 취득한다.",
    labels: [["MATCH", "상대적 효력이다"], ["ERROR", "甲이 건물을 다시 소유하여 토지와 건물이 갈라진다"], ["ERROR", "지상권을 취득한다"]], rate: 1 / 3,
  },
  {
    kind: "opposite", answer: "취소로 모든 매매가 절대적으로 무효가 된다. 丙은 지상권을 취득한다.",
    labels: [["ERROR", "절대적으로 무효가 된다"], ["MISSING", ""], ["ERROR", "지상권을 취득한다"]], rate: 0,
  },
  {
    kind: "abstention", answer: "모르겠음",
    labels: [["MISSING", ""], ["MISSING", ""], ["MISSING", ""]], rate: 0,
  },
];

test("seven public-law gold-label cases stay deterministic without inventing official points", () => {
  for (const item of cases) {
    const analysis = {
      elements: anchors.map(([category, criterion, modelExcerpt], index) => ({
        category, criterion, modelExcerpt, status: item.labels[index][0],
        answerExcerpt: item.labels[index][1], explanation: `공개 판례에 따른 ${item.kind} 표본의 수동 판정`,
      })),
      matchedLaw: [], missingLaw: [], misappliedLaw: [], improvement: "누락·오류 법리를 확인한다",
      decompositionRationale: "공개 판례 요지에서 세 요소를 고정했다",
      scoreRationale: "공식 문제 배점은 사용하지 않았다",
    };
    const args = { modelAnswer, rubric: "공개 판례 요지", originalAnswer: item.answer, awardedPoints: 0 };
    const first = buildP2SemanticAudit(analysis, args);
    const repeat = buildP2SemanticAudit(analysis, args);
    assert.deepEqual(repeat, first, item.kind);
    assert.equal(first.coreElementMatch.rate, item.rate, item.kind);
    assert.equal(first.aiScore, undefined);
    assert.equal(isNonSubstantiveP2Answer(item.answer), item.kind === "abstention");
  }
});
