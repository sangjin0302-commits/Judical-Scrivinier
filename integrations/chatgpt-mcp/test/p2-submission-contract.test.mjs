import assert from "node:assert/strict";
import test from "node:test";

import { normalizeP2Submission } from "../db/p2-submission-contract.mjs";
import { buildP2SemanticAudit } from "../db/p2-semantic-evaluation.mjs";

test("partial case submission preserves originals and marks omitted subquestions separately", () => {
  const issued = ["case-1-a", "case-1-b", "case-1-c"];
  const answers = [{ key: "case-1-b", text: "  실제 작성한 법리.\n" },
    { key: "case-1-a", text: "모르겠다." }];
  const before = structuredClone(answers);
  const result = normalizeP2Submission(issued, answers);
  assert.deepEqual(answers, before);
  assert.deepEqual(result.submittedAnswers, [answers[1], answers[0]]);
  assert.deepEqual(result.unsubmittedKeys, ["case-1-c"]);
  assert.deepEqual(result.subquestions.map((item) => item.submissionStatus),
    ["SUBMITTED", "SUBMITTED", "UNSUBMITTED"]);
  assert.equal(result.submittedAnswers[0].text, "모르겠다.");
  assert.equal(result.submittedAnswers.some((item) => item.key === "case-1-c"), false);
  assert.deepEqual(normalizeP2Submission(issued, answers), result);
});

test("partial submission rejects unknown, duplicate, blank and entirely absent answers", () => {
  const issued = ["a", "b"];
  assert.throws(() => normalizeP2Submission(issued, []), /at least one/);
  assert.throws(() => normalizeP2Submission(issued, [{ key: "c", text: "답" }]), /not in issued/);
  assert.throws(() => normalizeP2Submission(issued, [{ key: "a", text: "답" },
    { key: "a", text: "다른 답" }]), /duplicate/);
  assert.throws(() => normalizeP2Submission(issued, [{ key: "a", text: "  " }]), /empty/);
  assert.throws(() => normalizeP2Submission(["a", "a"], [{ key: "a", text: "답" }]), /invalid issued/);
});

const source = { modelAnswer: "요건을 충족한다.", rubric: "요건 검토 필수", maxPoints: 15 };
const missing = { elements: [{ category: "ELEMENT", criterion: "요건", status: "MISSING",
  modelExcerpt: "요건", answerExcerpt: "", explanation: "작성하지 않았다" }],
  matchedLaw: [], missingLaw: ["요건"], misappliedLaw: [], improvement: "요건을 작성한다",
  decompositionRationale: "공식 요건", scoreRationale: "미제출은 0점" };

test("unsubmitted subquestion yields zero without inventing an original answer", () => {
  const result = buildP2SemanticAudit(missing,
    { ...source, originalAnswer: undefined, submissionStatus: "UNSUBMITTED" });
  assert.equal(result.submissionStatus, "UNSUBMITTED");
  assert.equal(result.coreElementMatch.rate, 0);
  assert.equal(result.learningScore.displayedPoints, 0);
  assert.equal(result.elements[0].answerEvidenceDigest, null);
  assert.throws(() => buildP2SemanticAudit({ ...missing, elements: [{ ...missing.elements[0],
    status: "MATCH", answerExcerpt: "가공 답안" }] },
  { ...source, submissionStatus: "UNSUBMITTED" }), /answer evidence absent/);
  assert.throws(() => buildP2SemanticAudit(missing,
    { ...source, originalAnswer: "모르겠다", submissionStatus: "UNSUBMITTED" }), /answer\/status mismatch/);
  assert.throws(() => buildP2SemanticAudit(missing,
    { ...source, originalAnswer: undefined, submissionStatus: "SUBMITTED" }), /answer\/status mismatch/);
});

test("literal abstention remains submitted and scores zero, distinct from omission", () => {
  const result = buildP2SemanticAudit(missing,
    { ...source, originalAnswer: "모르겠다", submissionStatus: "SUBMITTED" });
  assert.equal(result.submissionStatus, "SUBMITTED");
  assert.equal(result.learningScore.displayedPoints, 0);
  assert.deepEqual(buildP2SemanticAudit(missing,
    { ...source, originalAnswer: "모르겠다", submissionStatus: "SUBMITTED" }), result);
});
