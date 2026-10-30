import { createHash } from "node:crypto";
import { calculateP2LearningScore } from "./p2-semantic-evaluation.mjs";

// Private acceptance input only. Callers must supply the issued immutable question
// snapshot, including common facts. Never log this return value: it contains originals.
export function buildPrivateP2EvaluationInput(source, { expectedPromptDigest, sourceVersion } = {}) {
  for (const field of ["questionText", "modelAnswer", "rubric", "originalAnswer"]) {
    if (typeof source?.[field] !== "string" || !source[field].trim()) {
      throw new Error(`private evaluation requires ${field}`);
    }
  }
  if (source.submissionStatus !== "SUBMITTED") throw new Error("submitted original required");
  if (!expectedPromptDigest && !(typeof sourceVersion === "string" && sourceVersion.trim())) {
    throw new Error("issued question provenance required");
  }
  const promptDigest = createHash("sha256").update(source.questionText, "utf8").digest("hex");
  if (expectedPromptDigest && (!/^[a-f0-9]{64}$/u.test(expectedPromptDigest) ||
      expectedPromptDigest !== promptDigest)) throw new Error("issued question digest mismatch");
  calculateP2LearningScore([{ status: "MISSING" }], source.maxPoints);
  return { questionText: source.questionText, modelAnswer: source.modelAnswer,
    rubric: source.rubric, originalAnswer: source.originalAnswer,
    maxPoints: Number(source.maxPoints), submissionStatus: "SUBMITTED",
    sourceContext: { promptDigest, ...(sourceVersion ? { sourceVersion } : {}) } };
}
