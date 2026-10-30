import test from "node:test";
import assert from "node:assert/strict";
import { compareP2Evaluations } from "../db/p2-repeatability.mjs";

const source = { modelAnswer: "private-rule private-conclusion", rubric: "private-rubric",
  originalAnswer: "private-answer-rule private-answer-conclusion", maxPoints: 10 };
const reference = { elements: ["rule", "conclusion"].map((key) => ({
  criterion: key, category: key === "rule" ? "LAW" : "CONCLUSION", status: "MATCH",
  modelExcerpt: `private-${key}`, answerExcerpt: `private-answer-${key}`,
  explanation: "private explanation",
})), matchedLaw: [], missingLaw: [], misappliedLaw: [], improvement: "private improvement",
  decompositionRationale: "private decomposition", scoreRationale: "private rationale" };
const copy = () => structuredClone(reference);
const run = (runs) => compareP2Evaluations({ source, referenceAnalysis: reference, runs });

test("reordered identical outputs agree but never prove semantic accuracy or open gate", () => {
  const second = copy(); second.elements.reverse();
  const result = run([copy(), second]);
  assert.equal(result.allAgreeWithReference, true);
  assert.equal(result.semanticCorrectnessVerified, false);
  assert.equal(result.gateMayBeEnabled, false);
  assert.equal(result.scoreRange.spread, 0);
  assert.ok(!JSON.stringify(result).includes("private"));
});

test("same total score cannot hide swapped classifications", () => {
  const a = copy(), b = copy();
  a.elements[0].status = "PARTIAL";
  b.elements[1].status = "PARTIAL";
  const result = run([a, b]);
  assert.equal(result.scoreRange.spread, 0);
  assert.equal(result.allAgreeWithReference, false);
  assert.equal(result.runs[0].statusDifferences, 1);
});

test("missing and extra criteria and changed valid evidence are reported", () => {
  const a = copy(), b = copy();
  a.elements[0].criterion = "different criterion";
  b.elements[0].modelExcerpt = "private-rule private-conclusion";
  const result = run([a, b]);
  assert.equal(result.runs[0].missingCriteria, 1);
  assert.equal(result.runs[0].extraCriteria, 1);
  assert.equal(result.runs[1].evidenceDifferences, 1);
});

test("fabricated excerpts and duplicate criteria fail closed without leaking content", () => {
  const a = copy(), b = copy();
  a.elements[0].answerExcerpt = "secret fabricated text";
  b.elements[1].criterion = b.elements[0].criterion;
  const result = run([a, b]);
  assert.equal(result.invalidRunCount, 2);
  assert.equal(result.scoreRange, null);
  assert.equal(result.allAgreeWithReference, false);
  assert.ok(!JSON.stringify(result).includes("secret"));
});

test("requires multiple runs and valid reference and official maximum", () => {
  assert.throws(() => run([copy()]));
  assert.throws(() => compareP2Evaluations({ source: {}, referenceAnalysis: reference,
    runs: [copy(), copy()] }));
  const bad = copy(); bad.elements[0].modelExcerpt = "unanchored";
  assert.throws(() => compareP2Evaluations({ source, referenceAnalysis: bad,
    runs: [copy(), copy()] }));
});
