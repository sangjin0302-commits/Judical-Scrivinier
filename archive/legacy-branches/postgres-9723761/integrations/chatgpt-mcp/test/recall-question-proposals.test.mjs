import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareRecallQuestionProposal } from "../db/recall-question-proposals.mjs";

const index = {
  questions: new Map([["B1-P0008-0011-Q1", { unitId: "B1-P0008-0011" }]]),
  issues: new Map([["B1-P0008-0011-I01", { unitId: "B1-P0008-0011", tier: "A" }],
    ["B1-P0012-0018-I01", { unitId: "B1-P0012-0018", tier: "A" }]]),
};
const candidate = {
  questionId: "B1-P0008-0011-Q1", issueId: "B1-P0008-0011-I01",
  proposedPrompt: "민법전의 조문과 다른 민사 특별법이 함께 있으면 적용 범위를 무엇부터 확인하는가?",
  focus: "ELEMENT",
  source: { path: "approved/unit-source", version: `sha256:${"a".repeat(64)}`,
    verifiedBy: "reviewer-id", verifiedAt: "2026-10-29" },
  legalEvidence: [{ type: "statute", ref: "verified-primary-source-id" }],
  approvalState: "PENDING",
};

test("proposal is review-only metadata, with no active prompt or source text", () => {
  const result = prepareRecallQuestionProposal(candidate, index);
  assert.equal(result.questionId, candidate.questionId);
  assert.equal(result.issueTier, "A");
  assert.equal(result.activePromptChanged, false);
  assert.equal(result.approvalState, "PENDING");
  assert.match(result.proposedPromptDigest, /^[0-9a-f]{64}$/);
  assert.equal("proposedPrompt" in result, false);
});

test("unmapped issue, generic wording, missing evidence, or preapproval fail closed", () => {
  assert.throws(() => prepareRecallQuestionProposal({ ...candidate, issueId: "B1-P0012-0018-I01" }, index));
  assert.throws(() => prepareRecallQuestionProposal({ ...candidate,
    proposedPrompt: "이 단원의 핵심 법리 전체를 모두 설명하시오?" }, index));
  assert.throws(() => prepareRecallQuestionProposal({ ...candidate, legalEvidence: [] }, index));
  assert.throws(() => prepareRecallQuestionProposal({ ...candidate, legalEvidence: [null] }, index));
  assert.throws(() => prepareRecallQuestionProposal({ ...candidate,
    legalEvidence: [{ type: "case", ref: "" }] }, index));
  assert.throws(() => prepareRecallQuestionProposal({ ...candidate,
    source: { ...candidate.source, verifiedAt: "unknown" } }, index));
  assert.throws(() => prepareRecallQuestionProposal({ ...candidate, approvalState: "APPROVED" }, index));
});
