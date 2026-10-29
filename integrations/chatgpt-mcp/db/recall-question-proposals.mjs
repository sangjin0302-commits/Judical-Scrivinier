import { createHash } from "node:crypto";

const FOCUS = new Set(["PARTY", "ELEMENT", "EFFECT", "EXCEPTION"]);
const EVIDENCE_TYPES = new Set(["statute", "case", "official-interpretation"]);
const BROAD = /(핵심\s*법리\s*(전체|모두)|전체\s*법리|모든\s*법리)/;
const hash = (text) => createHash("sha256").update(text).digest("hex");

// Review metadata only. This function neither writes to DB nor activates a prompt.
export function prepareRecallQuestionProposal(candidate, index) {
  const question = index.questions.get(candidate?.questionId);
  const issue = index.issues.get(candidate?.issueId);
  if (!question || !issue || question.unitId !== issue.unitId ||
      !["A", "B", "C"].includes(issue.tier)) {
    throw new Error("verified same-unit issue required");
  }
  const prompt = String(candidate.proposedPrompt || "").trim();
  if (prompt.length < 15 || prompt.length > 500 || BROAD.test(prompt) ||
      !/[?？]$/.test(prompt)) throw new Error("specific review question required");
  if (!FOCUS.has(candidate.focus)) throw new Error("question focus required");
  if (!candidate.source?.path || !/^sha256:[0-9a-f]{64}$/.test(candidate.source.version || "") ||
      !candidate.source.verifiedBy || !/^\d{4}-\d{2}-\d{2}$/.test(candidate.source.verifiedAt || "") ||
      !Array.isArray(candidate.legalEvidence) || !candidate.legalEvidence.length ||
      candidate.legalEvidence.length > 20 || candidate.legalEvidence.some((item) =>
        !EVIDENCE_TYPES.has(item?.type) || typeof item.ref !== "string" ||
        !item.ref.trim() || item.ref.length > 500)) {
    throw new Error("source and legal verification evidence required");
  }
  if (candidate.approvalState !== "PENDING") throw new Error("proposal must remain pending review");
  return {
    questionId: candidate.questionId, unitId: question.unitId,
    issueId: candidate.issueId, issueTier: issue.tier, focus: candidate.focus,
    proposedPromptDigest: hash(prompt), sourcePath: candidate.source.path,
    sourceVersion: candidate.source.version, legalEvidenceCount: candidate.legalEvidence.length,
    approvalState: "PENDING", activePromptChanged: false,
  };
}
