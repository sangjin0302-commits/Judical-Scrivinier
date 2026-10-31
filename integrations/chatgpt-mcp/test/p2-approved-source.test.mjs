import test from "node:test";
import assert from "node:assert/strict";
import { createP2CriteriaManifest, validateP2ApprovedSource } from "../db/p2-fixed-criteria.mjs";
import { p2PublicationDigest as digest } from "../db/publish-p2-fixed-criteria.mjs";

function fixture() {
  const payload = { answer: "A", rubric: "A" };
  payload.fixedCriteriaManifest = createP2CriteriaManifest([
    { category: "LAW", criterion: "A", modelExcerpt: "A" },
  ], { modelAnswer: "A", rubric: "A" });
  payload.fixedDecisionRubric = {
    elements: [{ ...payload.fixedCriteriaManifest.requiredElements[0], explanation: "Synthetic",
      requiredPropositions: ["A"], matchCondition: "A", partialCondition: "Partial A",
      errorCondition: "Contradicts A", missingCondition: "No A" }],
    decompositionRationale: "Synthetic", changesFromPrevious: "", unresolvedAmbiguities: [],
  };
  payload.fixedCriteriaReviewEvidence = { sourceOnly: true, learnerAnswersProvidedToRubricReview: false,
    duplicateGroups: 0, unsupportedElements: 0, requiresRevision: false,
    criteriaFile: "synthetic", criteriaFileDigest: digest("criteria"),
    auditFile: "synthetic", auditFileDigest: digest("audit") };
  const snapshot = { problemVersionId: "synthetic-v1", problemDigest: digest("prompt") };
  payload.fixedCriteriaApproval = { ...snapshot, reviewId: "synthetic", reviewerId: "agent",
    reviewedAt: "2026-01-01T00:00:00Z", originalKeyVersion: "v1", originalEncryptionKeyId: "key1",
    originalPayloadDigest: digest("original"), criteriaDigest: payload.fixedCriteriaManifest.criteriaDigest,
    decisionRubricDigest: digest(payload.fixedDecisionRubric),
    reviewEvidenceDigest: digest(payload.fixedCriteriaReviewEvidence) };
  return { payload, snapshot };
}

test("approved encrypted source binds fixed criteria, decision rules and review to issued snapshot", () => {
  const { payload, snapshot } = fixture();
  const before = JSON.stringify(payload);
  assert.equal(validateP2ApprovedSource(payload, snapshot).problemVersionId, snapshot.problemVersionId);
  assert.equal(JSON.stringify(payload), before);
});
test("legacy or missing approved components fail closed", () => {
  for (const key of ["fixedCriteriaManifest", "fixedDecisionRubric", "fixedCriteriaReviewEvidence", "fixedCriteriaApproval"]) {
    const { payload, snapshot } = fixture();
    delete payload[key];
    assert.throws(() => validateP2ApprovedSource(payload, snapshot));
  }
});
test("changed source, issued snapshot, decision rules or approval digest fail closed", () => {
  for (const change of [
    p => { p.answer = "A B"; }, p => { p.fixedDecisionRubric.elements[0].matchCondition = "Anything"; },
    p => { p.fixedCriteriaApproval.criteriaDigest = digest("other"); },
    p => { p.fixedCriteriaApproval.problemVersionId = "other"; },
    p => { p.fixedCriteriaApproval.problemDigest = digest("other"); },
    p => { p.fixedCriteriaApproval.reviewEvidenceDigest = digest("other"); },
  ]) {
    const { payload, snapshot } = fixture(); change(payload);
    assert.throws(() => validateP2ApprovedSource(payload, snapshot));
  }
});
test("unsafe review flags rejected even when review digest is recomputed", () => {
  for (const [key, value] of Object.entries({ sourceOnly: false, learnerAnswersProvidedToRubricReview: true,
    duplicateGroups: 1, unsupportedElements: 1, requiresRevision: true })) {
    const { payload, snapshot } = fixture();
    payload.fixedCriteriaReviewEvidence[key] = value;
    payload.fixedCriteriaApproval.reviewEvidenceDigest = digest(payload.fixedCriteriaReviewEvidence);
    assert.throws(() => validateP2ApprovedSource(payload, snapshot), /source-only review required/);
  }
});

test("unresolved decision ambiguity rejects even with a matching approval digest", () => {
  const { payload, snapshot } = fixture();
  payload.fixedDecisionRubric.unresolvedAmbiguities = ["Synthetic unresolved source ambiguity"];
  payload.fixedCriteriaApproval.decisionRubricDigest = digest(payload.fixedDecisionRubric);
  assert.throws(() => validateP2ApprovedSource(payload, snapshot), /unresolved ambiguities/);
});
