import assert from "node:assert/strict";
import test from "node:test";
import { validateP2ScoreBasis, validateP2ScoreGroup, p2ScoreBasisDigest } from "../db/p2-score-basis.mjs";
const expected = { problemVersionId: "version-1", promptDigest: "a".repeat(64), evidenceDigest: "b".repeat(64) };
const basis = { schemaVersion: 1, ...expected, mode: "allocated_learning", approvalStatus: "approved",
  approvalId: "source-review-1", sourceGroupKey: "synthetic-group", originalGroupMaximum: 15,
  allocatedLearningMaximum: 7.5, allocationPolicy: "approved-equal-halves-v1", allocationApprovalId: "allocation-review-1" };
expected.scoreBasisDigest = p2ScoreBasisDigest(basis);
const entry = (id) => { const value = { ...basis, problemVersionId: id }; return { basis: value,
  expected: { ...expected, problemVersionId: id, scoreBasisDigest: p2ScoreBasisDigest(value) } }; };
const group = { sourceGroupKey: "synthetic-group", originalGroupMaximum: 15, problemVersionIds: ["version-1", "version-2"] };

test("allocated learning maximum cannot be presented as an official subquestion maximum", () => {
  const value = validateP2ScoreBasis(basis, expected);
  assert.equal(value.learningMaximum, 7.5);
  assert.equal(value.originalGroupMaximum, 15);
  assert.equal(Object.hasOwn(value, "officialMaximum"), false);
  assert.match(value.label, /학습용 분할/);
  const mixed = { ...basis, officialSubquestionMaximum: 7.5 };
  assert.throws(() => validateP2ScoreBasis(mixed, { ...expected, scoreBasisDigest: p2ScoreBasisDigest(mixed) }));
});
test("official subquestion mode requires explicit official maximum and excludes allocation fields", () => {
  const { allocatedLearningMaximum, allocationPolicy, allocationApprovalId, ...official } = basis;
  const approved = { ...official, mode: "official_subquestion", officialSubquestionMaximum: 10 };
  const value = validateP2ScoreBasis(approved, { ...expected, scoreBasisDigest: p2ScoreBasisDigest(approved) });
  assert.equal(value.officialMaximum, 10);
  assert.equal(value.learningMaximum, 10);
  assert.throws(() => validateP2ScoreBasis({ ...basis, mode: "official_subquestion", officialSubquestionMaximum: 10 }, expected));
});
test("unapproved, missing, stale or self-unbound evidence fails closed", () => {
  for (const patch of [{ approvalStatus: "pending" }, { approvalId: "" }, { allocationApprovalId: "" },
    { problemVersionId: "old" }, { promptDigest: "c".repeat(64) }, { evidenceDigest: "c".repeat(64) },
    { mode: "inferred" }, { allocationPolicy: "" }]) {
    assert.throws(() => validateP2ScoreBasis({ ...basis, ...patch }, expected));
  }
  assert.throws(() => validateP2ScoreBasis(basis, {}));
  assert.throws(() => validateP2ScoreBasis({ ...basis, allocatedLearningMaximum: 5 }, expected));
  assert.throws(() => validateP2ScoreBasis({ ...basis, allocationPolicy: "unreviewed" }, expected));
});
test("invalid precision, nonnumeric values and group overflow are rejected", () => {
  for (const n of [0, -1, NaN, Infinity, "7.5", 0.001, 16]) {
    const invalid = { ...basis, allocatedLearningMaximum: n };
    assert.throws(() => validateP2ScoreBasis(invalid, { ...expected, scoreBasisDigest: p2ScoreBasisDigest(invalid) }));
  }
});
test("complete group sums precisely to original maximum without duplicated group points", () => {
  assert.equal(validateP2ScoreGroup([entry("version-1"), entry("version-2")], group).learningMaximum, 15);
  const duplicated = [entry("version-1"), entry("version-2")].map(e => ({ ...e, basis: { ...e.basis, allocatedLearningMaximum: 15 } }));
  for (const e of duplicated) e.expected.scoreBasisDigest = p2ScoreBasisDigest(e.basis);
  assert.throws(() => validateP2ScoreGroup(duplicated, group));
});
test("partial groups, duplicate versions, wrong groups and incomplete allocations are rejected", () => {
  assert.throws(() => validateP2ScoreGroup([entry("version-1")], group));
  assert.throws(() => validateP2ScoreGroup([entry("version-1"), entry("version-1")], group));
  assert.throws(() => validateP2ScoreGroup([entry("version-1"), entry("version-3")], group));
  const entries = [entry("version-1"), entry("version-2")];
  entries[1].basis.allocatedLearningMaximum = 5;
  entries[1].expected.scoreBasisDigest = p2ScoreBasisDigest(entries[1].basis);
  assert.throws(() => validateP2ScoreGroup(entries, group));
  entries[1].basis.allocatedLearningMaximum = 7.5;
  entries[1].basis.sourceGroupKey = "other";
  entries[1].expected.scoreBasisDigest = p2ScoreBasisDigest(entries[1].basis);
  assert.throws(() => validateP2ScoreGroup(entries, group));
});
