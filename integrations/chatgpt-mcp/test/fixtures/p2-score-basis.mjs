import { createHash } from "node:crypto";
import { p2ScoreBasisDigest } from "../../db/p2-score-basis.mjs";
export function syntheticAllocatedScoreItem({ id = "allocated-v1", maximum = 7.5, groupMaximum = 15 } = {}) {
  const prompt = "Synthetic scoring contract question.";
  const promptDigest = createHash("sha256").update(prompt).digest("hex");
  const basis = { schemaVersion: 1, mode: "allocated_learning", approvalStatus: "approved",
    approvalId: "synthetic-source-approval", allocationApprovalId: "synthetic-allocation-approval",
    allocationPolicy: "synthetic-equal-division-v1", sourceGroupKey: "synthetic-group",
    problemVersionId: id, promptDigest, evidenceDigest: "d".repeat(64),
    originalGroupMaximum: groupMaximum, allocatedLearningMaximum: maximum };
  return { item: { problem_version_id: id, problem_prompt_digest: promptDigest, prompt_text: prompt,
    max_points: maximum, selection_metadata: { scoreBasis: basis } },
    gradingSource: { scoreBasisApproval: { problemVersionId: id, promptDigest,
      evidenceDigest: basis.evidenceDigest, scoreBasisDigest: p2ScoreBasisDigest(basis) } } };
}
