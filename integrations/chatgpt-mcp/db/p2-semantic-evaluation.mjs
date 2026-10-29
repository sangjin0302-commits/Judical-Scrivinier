import { createHash } from "node:crypto";

const CATEGORIES = new Set(["ISSUE", "LAW", "ELEMENT", "PRECEDENT", "APPLICATION", "CONCLUSION"]);
const STATUSES = new Set(["MATCH", "PARTIAL", "MISSING", "ERROR", "ALTERNATIVE_ACCEPTED"]);
const FULL_MATCH = new Set(["MATCH", "ALTERNATIVE_ACCEPTED"]);
const SCORE_WEIGHTS = Object.freeze({ MATCH: 2, ALTERNATIVE_ACCEPTED: 2, PARTIAL: 1,
  MISSING: 0, ERROR: 0 });

const clean = (value) => String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
export const isNonSubstantiveP2Answer = (value) =>
  /^(?:모르겠음|모르겠다|모르겠습니다|모름|잘 모르겠습니다|알 수 없습니다|i(?: do not| don't) know)[.!?]?$/iu.test(clean(value));
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

function bounded(value, field, limit = 2000) {
  const text = clean(value);
  if (!text || text.length > limit) throw new Error(`invalid ${field}`);
  return text;
}

function stringList(value, field) {
  if (!Array.isArray(value) || value.length > 30) throw new Error(`invalid ${field}`);
  return value.map((item) => bounded(item, field, 1000));
}

// Monetary precision is 0.01 point. Retain exact rational calculation and raw value.
export function calculateP2LearningScore(elements, maxPoints) {
  if (!Array.isArray(elements) || elements.length < 1 || elements.length > 30) {
    throw new Error("invalid required semantic elements");
  }
  const maximum = Number(maxPoints);
  const maximumCents = Math.round(maximum * 100);
  if (!Number.isFinite(maximum) || maximum <= 0 || maximum > 999999.99 ||
      Math.abs(maximumCents / 100 - maximum) > 1e-9) {
    throw new Error("invalid official maximum");
  }
  let earnedHalfUnits = 0;
  for (const element of elements) {
    if (!Object.hasOwn(SCORE_WEIGHTS, element?.status)) throw new Error("invalid semantic score status");
    earnedHalfUnits += SCORE_WEIGHTS[element.status];
  }
  const totalHalfUnits = elements.length * 2;
  const rawNumeratorCents = maximumCents * earnedHalfUnits;
  const rawPoints = rawNumeratorCents / totalHalfUnits / 100;
  const displayedPoints = Math.round(rawNumeratorCents / totalHalfUnits) / 100;
  return {
    label: "AI 학습평가 점수 (공식 채점자 점수 아님)",
    rawPoints,
    displayedPoints,
    displayedText: displayedPoints.toFixed(2),
    maximumPoints: maximum,
    earnedHalfUnits,
    totalHalfUnits,
    rawFraction: `${rawNumeratorCents}/${totalHalfUnits * 100}`,
    formula: "official maximum × (MATCH + ALTERNATIVE_ACCEPTED + 0.5 × PARTIAL) / required elements",
    calculationRationale: `${maximum.toFixed(2)} × ${earnedHalfUnits}/${totalHalfUnits} = ${displayedPoints.toFixed(2)} (원계산값 ${rawPoints})`,
  };
}

// Exact excerpts are evidence anchors only. Match judgments remain semantic, made after original submission.
export function buildP2SemanticAudit(analysis, { modelAnswer, rubric, originalAnswer, awardedPoints,
  maxPoints, submissionStatus = "SUBMITTED" } = {}) {
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) throw new Error("semantic analysis required");
  const source = clean(`${modelAnswer || ""} ${rubric || ""}`);
  const original = clean(originalAnswer);
  if (!new Set(["SUBMITTED", "UNSUBMITTED"]).has(submissionStatus)) throw new Error("invalid P2 submission status");
  const unsubmitted = submissionStatus === "UNSUBMITTED";
  if (!source || (!original && !unsubmitted) || (unsubmitted && original)) {
    throw new Error("grading source or original answer/status mismatch");
  }
  const abstained = isNonSubstantiveP2Answer(original);
  if ((abstained || unsubmitted) && Number(awardedPoints) > 0) {
    throw new Error("non-substantive or unsubmitted answer cannot earn points");
  }
  if (!Array.isArray(analysis.elements) || analysis.elements.length < 1 || analysis.elements.length > 30) {
    throw new Error("invalid semantic elements");
  }
  const seen = new Set();
  const elements = analysis.elements.map((entry) => {
    const category = bounded(entry?.category, "element category", 30);
    const status = bounded(entry?.status, "element status", 30);
    if (!CATEGORIES.has(category) || !STATUSES.has(status)) throw new Error("invalid semantic element classification");
    const criterion = bounded(entry.criterion, "element criterion", 500);
    const identity = criterion.toLocaleLowerCase("ko-KR");
    if (seen.has(identity)) throw new Error("duplicate semantic element");
    seen.add(identity);
    const modelExcerpt = bounded(entry.modelExcerpt, "model evidence", 2000);
    if (!source.includes(modelExcerpt)) throw new Error("model evidence absent from official source");
    const answerExcerpt = clean(entry.answerExcerpt);
    if (status === "MISSING" ? answerExcerpt : !answerExcerpt) throw new Error("answer evidence/status mismatch");
    if (answerExcerpt && !original.includes(answerExcerpt)) throw new Error("answer evidence absent from original answer");
    const explanation = bounded(entry.explanation, "element explanation", 2000);
    const alternativeSourceRef = clean(entry.alternativeSourceRef);
    if (status === "ALTERNATIVE_ACCEPTED" && !alternativeSourceRef) {
      throw new Error("alternative legal basis requires source reference");
    }
    return { category, criterion, status, explanation,
      modelEvidenceDigest: sha256(modelExcerpt),
      answerEvidenceDigest: answerExcerpt ? sha256(answerExcerpt) : null,
      ...(alternativeSourceRef ? { alternativeSourceRef: bounded(alternativeSourceRef, "alternative source", 500) } : {}) };
  });
  const matchedCount = elements.filter((item) => FULL_MATCH.has(item.status)).length;
  const partialCount = elements.filter((item) => item.status === "PARTIAL").length;
  if ((abstained || unsubmitted) && elements.some((item) => item.status !== "MISSING")) {
    throw new Error("non-substantive or unsubmitted answer must mark every element missing");
  }
  if ((abstained || unsubmitted) &&
      ((analysis.matchedLaw?.length || 0) > 0 || (analysis.misappliedLaw?.length || 0) > 0)) {
    throw new Error("non-substantive or unsubmitted answer cannot claim matched or misapplied law");
  }
  if (Number(awardedPoints) > 0 && matchedCount + partialCount === 0) {
    throw new Error("positive points require supported matched or partial elements");
  }
  const missingCount = elements.filter((item) => item.status === "MISSING").length;
  const errorCount = elements.filter((item) => item.status === "ERROR").length;
  const weightedRate = (matchedCount + 0.5 * partialCount) / elements.length;
  const learningScore = maxPoints == null ? undefined : calculateP2LearningScore(elements, maxPoints);
  if (learningScore && awardedPoints != null &&
      Math.abs(Number(awardedPoints) - learningScore.displayedPoints) > 1e-9) {
    throw new Error("awarded points differ from calculated AI learning score");
  }
  return {
    method: "model-answer-element-ratio-v1",
    submissionStatus,
    elements,
    coreElementMatch: { matchedCount, partialCount, missingCount, errorCount,
      totalCount: elements.length, rate: weightedRate,
      formula: "(MATCH + ALTERNATIVE_ACCEPTED + 0.5 × PARTIAL) / required elements" },
    ...(learningScore ? { learningScore } : {}),
    matchedLaw: stringList(analysis.matchedLaw, "matched law"),
    missingLaw: stringList(analysis.missingLaw, "missing law"),
    misappliedLaw: stringList(analysis.misappliedLaw, "misapplied law"),
    improvement: bounded(analysis.improvement, "improvement", 5000),
    decompositionRationale: bounded(analysis.decompositionRationale, "decomposition rationale", 5000),
    scoreRationale: bounded(analysis.scoreRationale, "score rationale", 5000),
    officialSourceDigest: sha256(source),
  };
}
