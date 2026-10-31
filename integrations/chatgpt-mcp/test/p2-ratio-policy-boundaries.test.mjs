import assert from "node:assert/strict";
import test from "node:test";
import { calculateP2LearningScore } from "../db/p2-semantic-evaluation.mjs";
import { createP2CriteriaManifest, validateP2FixedCriteria } from "../db/p2-fixed-criteria.mjs";

// Synthetic source only. These checks verify policy enforcement, not AI judgment.
const source = { modelAnswer: "Synthetic operative rule. Synthetic conclusion.", rubric: "Synthetic rubric." };
const required = [
  { category: "LAW", criterion: "operative rule", modelExcerpt: "Synthetic operative rule." },
  { category: "CONCLUSION", criterion: "conclusion", modelExcerpt: "Synthetic conclusion." },
];

test("fixed denominator rejects counting a rule again under a precedent label", () => {
  const manifest = createP2CriteriaManifest(required, source);
  const baseline = required.map((e, i) => ({ ...e, status: i ? "MATCH" : "MISSING" }));
  validateP2FixedCriteria(manifest, { elements: baseline }, source);
  assert.equal(calculateP2LearningScore(baseline, 15).displayedPoints, 7.5);
  const split = [...baseline, { category: "PRECEDENT", criterion: "same rule restated as precedent",
    modelExcerpt: "Synthetic operative rule.", status: "MISSING" }];
  // Arithmetic alone would accept this denominator and change the learner's score.
  assert.equal(calculateP2LearningScore(split, 15).displayedPoints, 5);
  assert.throws(() => validateP2FixedCriteria(manifest, { elements: split }, source),
    /evaluation criteria differ/);
});

test("a correct independent conclusion survives incorrect reasoning at official maximum", () => {
  const wrongReason = [{ status: "ERROR" }, { status: "MATCH" }];
  const partialReason = [{ status: "PARTIAL" }, { status: "MATCH" }];
  assert.equal(calculateP2LearningScore(wrongReason, 20).displayedPoints, 10);
  assert.equal(calculateP2LearningScore(partialReason, 20).displayedPoints, 15);
  assert.equal(calculateP2LearningScore(wrongReason, 15).displayedPoints, 7.5);
});
