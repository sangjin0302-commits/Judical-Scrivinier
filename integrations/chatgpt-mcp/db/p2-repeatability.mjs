import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildP2SemanticAudit } from "./p2-semantic-evaluation.mjs";

const identity = (text) => String(text ?? "").normalize("NFC")
  .replace(/\s+/gu, " ").trim().toLocaleLowerCase("ko-KR");

// Offline only. The caller supplies an independently reviewed reference and repeated
// evaluator outputs for ONE immutable source/answer pair. No DB or model calls.
// Return counts and scores only: never emit private text, identifiers or excerpts.
export function compareP2Evaluations({ referenceAnalysis, runs, source } = {}) {
  if (!Array.isArray(runs) || runs.length < 2 || runs.length > 100) {
    throw new Error("two to one hundred evaluation runs required");
  }
  if (!source || source.maxPoints == null) throw new Error("official maximum required");
  // Do not accept caller awardedPoints: recompute all scores with the existing contract.
  const context = { modelAnswer: source.modelAnswer, rubric: source.rubric,
    originalAnswer: source.originalAnswer, maxPoints: source.maxPoints,
    submissionStatus: source.submissionStatus };
  const reference = buildP2SemanticAudit(referenceAnalysis, context);
  const expected = new Map(reference.elements.map((e) => [identity(e.criterion), e]));
  const reports = runs.map((analysis, index) => {
    let audit;
    try { audit = buildP2SemanticAudit(analysis, context); }
    catch { return { run: index + 1, valid: false, reason: "INVALID_EVALUATION_CONTRACT" }; }
    const actual = new Map(audit.elements.map((e) => [identity(e.criterion), e]));
    let missingCriteria = 0, extraCriteria = 0, statusDifferences = 0;
    let categoryDifferences = 0, evidenceDifferences = 0;
    for (const [key, entry] of expected) {
      const other = actual.get(key);
      if (!other) { missingCriteria++; continue; }
      statusDifferences += Number(entry.status !== other.status);
      categoryDifferences += Number(entry.category !== other.category);
      evidenceDifferences += Number(entry.modelEvidenceDigest !== other.modelEvidenceDigest ||
        entry.answerEvidenceDigest !== other.answerEvidenceDigest ||
        entry.alternativeSourceRef !== other.alternativeSourceRef);
    }
    for (const key of actual.keys()) extraCriteria += Number(!expected.has(key));
    const score = audit.learningScore;
    return { run: index + 1, valid: true, missingCriteria, extraCriteria,
      statusDifferences, categoryDifferences, evidenceDifferences,
      rawPoints: score.rawPoints, displayedPoints: score.displayedPoints,
      scoreDifference: score.rawPoints - reference.learningScore.rawPoints,
      agreesWithReference: missingCriteria + extraCriteria + statusDifferences +
        categoryDifferences + evidenceDifferences === 0 };
  });
  const valid = reports.filter((r) => r.valid);
  const scores = valid.map((r) => r.rawPoints);
  return { method: "offline-reference-comparison-v1", semanticCorrectnessVerified: false,
    gateMayBeEnabled: false, runCount: runs.length, validRunCount: valid.length,
    invalidRunCount: runs.length - valid.length,
    classificationsAgreeWithReference: reports.every((r) => r.valid &&
      r.missingCriteria + r.extraCriteria + r.statusDifferences + r.categoryDifferences === 0),
    evidenceAgreesWithReference: reports.every((r) => r.valid && r.evidenceDifferences === 0),
    allAgreeWithReference: reports.every((r) => r.valid && r.agreesWithReference),
    referencePoints: reference.learningScore.rawPoints,
    scoreRange: scores.length ? { min: Math.min(...scores), max: Math.max(...scores),
      spread: Math.max(...scores) - Math.min(...scores) } : null,
    runs: reports };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    // Private input stays local. Only the redacted summary reaches stdout.
    const input = JSON.parse(await readFile(process.argv[2], "utf8"));
    process.stdout.write(JSON.stringify(compareP2Evaluations(input)) + "\n");
  } catch {
    process.stderr.write("P2 repeatability input or reference invalid\n");
    process.exitCode = 1;
  }
}
