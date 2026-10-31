import assert from "node:assert/strict";
import test from "node:test";
import { approvedP2ScoreBasis, publicP2ScoreBasis, withP2ScoreBasis, validateP2ScoreGroup } from "../db/p2-score-basis.mjs";
import { calculateP2LearningScore } from "../db/p2-semantic-evaluation.mjs";
import { syntheticAllocatedScoreItem } from "./fixtures/p2-score-basis.mjs";

test("issue presentation needs no private source and matches post-submission approval", () => {
  const { item, gradingSource } = syntheticAllocatedScoreItem();
  assert.deepEqual(publicP2ScoreBasis(item), approvedP2ScoreBasis(item, gradingSource));
  assert.equal(publicP2ScoreBasis(item).learningMaximum, 7.5);
});
test("approved source rejects altered metadata even when its public shape remains valid", () => {
  const { item, gradingSource } = syntheticAllocatedScoreItem();
  item.selection_metadata.scoreBasis.allocatedLearningMaximum = 5;
  item.max_points = 5;
  assert.equal(publicP2ScoreBasis(item).learningMaximum, 5);
  assert.throws(() => approvedP2ScoreBasis(item, gradingSource));
});
test("missing approval or metadata never falls back to legacy", () => {
  const { item, gradingSource } = syntheticAllocatedScoreItem();
  assert.throws(() => approvedP2ScoreBasis(item, {}));
  assert.throws(() => approvedP2ScoreBasis({ ...item, selection_metadata: {} }, gradingSource));
});
test("approved score is tied to issued version, prompt digest and immutable maximum", () => {
  const { item, gradingSource } = syntheticAllocatedScoreItem();
  for (const patch of [{ problem_version_id: "other" }, { problem_prompt_digest: "e".repeat(64) }, { max_points: 15 }]) {
    assert.throws(() => approvedP2ScoreBasis({ ...item, ...patch }, gradingSource));
  }
  assert.throws(() => publicP2ScoreBasis({ ...item, prompt_text: "Changed synthetic question." }));
});
test("historical score presentation remains unchanged; allocation formula never claims official maximum", () => {
  const legacy = calculateP2LearningScore([{ status: "PARTIAL" }], 15);
  assert.equal(approvedP2ScoreBasis({ selection_metadata: {} }, {}), null);
  assert.equal(withP2ScoreBasis(legacy, null), legacy);
  const { item, gradingSource } = syntheticAllocatedScoreItem();
  const value = withP2ScoreBasis(calculateP2LearningScore([{ status: "PARTIAL" }], 7.5), approvedP2ScoreBasis(item, gradingSource));
  assert.equal(value.rawPoints, 3.75);
  assert.match(value.formula, /^allocated learning maximum/);
  assert.equal(Object.hasOwn(value.scoreBasis, "officialMaximum"), false);
});
test("approved nine-item synthetic allocation preserves three independent group totals", () => {
  const groups = [[20, 5, 4], [15, 7.5, 2], [15, 5, 3]];
  let total = 0;
  for (const [maximum, allocation, count] of groups) {
    const fixtures = Array.from({ length: count }, (_, i) => syntheticAllocatedScoreItem({ id: `synthetic-${maximum}-${allocation}-${i}`, maximum: allocation, groupMaximum: maximum }));
    total += validateP2ScoreGroup(fixtures.map(({ item, gradingSource }) => ({ basis: item.selection_metadata.scoreBasis, expected: gradingSource.scoreBasisApproval })), {
      sourceGroupKey: "synthetic-group", originalGroupMaximum: maximum,
      problemVersionIds: fixtures.map(f => f.item.problem_version_id),
    }).learningMaximum;
  }
  assert.equal(total, 50);
});
