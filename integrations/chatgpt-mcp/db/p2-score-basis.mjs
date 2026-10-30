import { createHash } from "node:crypto";

// Standalone contract for versioned selection_metadata.scoreBasis.
// The caller must obtain expected bindings from a trusted approved source,
// never from an evaluation request. This module does not approve or persist data.
const DIGEST = /^[a-f0-9]{64}$/;
function fail() { throw new Error("P2 score basis is unapproved or inconsistent"); }
function cents(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 ||
      value > 999999.99 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-7) fail();
  return Math.round(value * 100);
}
function nonempty(value) { return typeof value === "string" && value.trim().length > 0; }

export function p2ScoreBasisDigest(basis) {
  if (!basis || typeof basis !== "object" || Array.isArray(basis) ||
      Object.values(basis).some(value => !["string", "number"].includes(typeof value))) fail();
  return createHash("sha256").update(JSON.stringify(Object.fromEntries(
    Object.keys(basis).sort().map(key => [key, basis[key]])))).digest("hex");
}

export function validateP2ScoreBasis(basis, expected) {
  if (!basis || !expected || basis.schemaVersion !== 1 || basis.approvalStatus !== "approved" ||
      !nonempty(basis.approvalId) || !nonempty(basis.sourceGroupKey) ||
      !nonempty(basis.problemVersionId) || !nonempty(expected.problemVersionId) ||
      basis.problemVersionId !== expected.problemVersionId ||
      !DIGEST.test(basis.promptDigest || "") || !DIGEST.test(expected.promptDigest || "") ||
      basis.promptDigest !== expected.promptDigest ||
      !DIGEST.test(basis.evidenceDigest || "") || !DIGEST.test(expected.evidenceDigest || "") ||
      basis.evidenceDigest !== expected.evidenceDigest ||
      !DIGEST.test(expected.scoreBasisDigest || "") ||
      p2ScoreBasisDigest(basis) !== expected.scoreBasisDigest) fail();
  const group = cents(basis.originalGroupMaximum);
  let maximum;
  if (basis.mode === "official_subquestion") {
    if (Object.hasOwn(basis, "allocatedLearningMaximum") || Object.hasOwn(basis, "allocationPolicy") ||
        Object.hasOwn(basis, "allocationApprovalId")) fail();
    maximum = cents(basis.officialSubquestionMaximum);
  } else if (basis.mode === "allocated_learning") {
    if (Object.hasOwn(basis, "officialSubquestionMaximum") ||
        !nonempty(basis.allocationPolicy) || !nonempty(basis.allocationApprovalId)) fail();
    maximum = cents(basis.allocatedLearningMaximum);
  } else fail();
  if (maximum > group) fail();
  return Object.freeze({ mode: basis.mode, sourceGroupKey: basis.sourceGroupKey,
    originalGroupMaximum: group / 100, learningMaximum: maximum / 100,
    ...(basis.mode === "official_subquestion" ? { officialMaximum: maximum / 100 } : {}),
    label: basis.mode === "official_subquestion" ? "공식 소문항 배점 기준 AI 학습평가" : "학습용 분할 배점 기준 AI 학습평가" });
}

// Only use for a complete approved source group, not a partial issued set.
export function validateP2ScoreGroup(entries, expectedGroup) {
  if (!Array.isArray(entries) || !entries.length || !expectedGroup ||
      !nonempty(expectedGroup.sourceGroupKey) ||
      !Array.isArray(expectedGroup.problemVersionIds) ||
      !expectedGroup.problemVersionIds.length ||
      expectedGroup.problemVersionIds.some(id => !nonempty(id))) fail();
  const required = new Set(expectedGroup.problemVersionIds);
  if (required.size !== expectedGroup.problemVersionIds.length || entries.length !== required.size) fail();
  const maximum = cents(expectedGroup.originalGroupMaximum);
  let sum = 0;
  let mode;
  for (const entry of entries) {
    const score = validateP2ScoreBasis(entry.basis, entry.expected);
    if (!required.delete(entry.basis.problemVersionId) ||
        score.sourceGroupKey !== expectedGroup.sourceGroupKey ||
        cents(score.originalGroupMaximum) !== maximum || (mode && mode !== score.mode)) fail();
    mode = score.mode;
    sum += cents(score.learningMaximum);
  }
  if (required.size || sum !== maximum) fail();
  return Object.freeze({ mode, sourceGroupKey: expectedGroup.sourceGroupKey,
    originalGroupMaximum: maximum / 100, learningMaximum: sum / 100,
    itemCount: entries.length });
}
