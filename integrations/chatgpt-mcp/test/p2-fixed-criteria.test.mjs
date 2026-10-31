import test from "node:test";
import assert from "node:assert/strict";
import { createP2CriteriaManifest, validateP2FixedCriteria } from "../db/p2-fixed-criteria.mjs";
import { buildP2SemanticAudit } from "../db/p2-semantic-evaluation.mjs";

const source = { modelAnswer: "A B", rubric: "A B", originalAnswer: "A", maxPoints: 10 };
const a = { category: "LAW", criterion: "A", modelExcerpt: "A", status: "MATCH",
  answerExcerpt: "A", explanation: "A present" };
const b = { category: "CONCLUSION", criterion: "B", modelExcerpt: "B", status: "MISSING",
  answerExcerpt: "", explanation: "B absent" };
const analysis = { elements: [a, b], matchedLaw: ["A"], missingLaw: ["B"], misappliedLaw: [],
  improvement: "Check B", decompositionRationale: "Synthetic A/B criteria", scoreRationale: "Ratio" };
const manifest = createP2CriteriaManifest([a, b], source);

test("fixed decomposition rejects changing the same answer from five to ten points by omitting B", () => {
  assert.equal(buildP2SemanticAudit(analysis, source).learningScore.displayedPoints, 5);
  const shortened = { ...analysis, elements: [a] };
  assert.equal(buildP2SemanticAudit(shortened, source).learningScore.displayedPoints, 10);
  assert.equal(validateP2FixedCriteria(manifest, analysis, source).requiredElementCount, 2);
  assert.throws(() => validateP2FixedCriteria(manifest, shortened, source), /differ from fixed manifest/);
});

test("fixed criteria permit reordered judgments but reject added, duplicate or altered criteria", () => {
  assert.equal(validateP2FixedCriteria(manifest, { elements: [b, a] }, source).criteriaDigest, manifest.criteriaDigest);
  for (const elements of [[a, a], [a, b, { ...a, criterion: "Extra" }],
    [a, { ...b, criterion: "Changed" }], [a, { ...b, category: "LAW" }],
    [a, { ...b, modelExcerpt: "A B" }]]) {
    assert.throws(() => validateP2FixedCriteria(manifest, { elements }, source));
  }
  assert.equal(validateP2FixedCriteria(manifest, { elements: [{ ...a, status: "PARTIAL" }, b] }, source)
    .requiredElementCount, 2);
});

test("fixed manifest rejects source changes and manifest tampering without mutating inputs", () => {
  assert.throws(() => validateP2FixedCriteria(manifest, analysis, { ...source, rubric: "A B C" }), /source or digest mismatch/);
  assert.throws(() => validateP2FixedCriteria({ ...manifest, requiredElements: [a] }, { elements: [a] }, source), /digest mismatch/);
  const before = JSON.stringify({ manifest, analysis });
  validateP2FixedCriteria(manifest, analysis, source);
  assert.equal(JSON.stringify({ manifest, analysis }), before);
});
