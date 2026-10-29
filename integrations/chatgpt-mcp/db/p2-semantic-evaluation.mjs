import { createHash } from "node:crypto";

const CATEGORIES = new Set(["ISSUE", "LAW", "ELEMENT", "PRECEDENT", "APPLICATION", "CONCLUSION"]);
const STATUSES = new Set(["MATCH", "PARTIAL", "MISSING", "ERROR", "ALTERNATIVE_ACCEPTED"]);
const FULL_MATCH = new Set(["MATCH", "ALTERNATIVE_ACCEPTED"]);

const clean = (value) => String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
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

// Exact excerpts are evidence anchors only. Match judgments remain semantic, made after original submission.
export function buildP2SemanticAudit(analysis, { modelAnswer, rubric, originalAnswer, awardedPoints }) {
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) throw new Error("semantic analysis required");
  const source = clean(`${modelAnswer || ""} ${rubric || ""}`);
  const original = clean(originalAnswer);
  if (!source || !original) throw new Error("grading source or original answer missing");
  const abstained = /^(?:모르겠다|모르겠습니다|모름|잘 모르겠습니다|알 수 없습니다|i(?: do not| don't) know)[.!?]?$/iu.test(original);
  if (abstained && Number(awardedPoints) > 0) throw new Error("non-substantive answer cannot earn points");
  if (!Array.isArray(analysis.elements) || analysis.elements.length < 1 || analysis.elements.length > 30) {
    throw new Error("invalid semantic elements");
  }
  const seen = new Set();
  const elements = analysis.elements.map((entry) => {
    const category = bounded(entry?.category, "element category", 30);
    const status = bounded(entry?.status, "element status", 30);
    if (!CATEGORIES.has(category) || !STATUSES.has(status)) throw new Error("invalid semantic element classification");
    const criterion = bounded(entry.criterion, "element criterion", 500);
    const identity = `${category}:${criterion}`;
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
  if (abstained && (matchedCount || partialCount)) throw new Error("non-substantive answer cannot match elements");
  const missingCount = elements.filter((item) => item.status === "MISSING").length;
  const errorCount = elements.filter((item) => item.status === "ERROR").length;
  return {
    method: "verified-element-count-v1",
    elements,
    coreElementMatch: { matchedCount, partialCount, missingCount, errorCount,
      totalCount: elements.length, rate: matchedCount / elements.length,
      formula: "(MATCH + ALTERNATIVE_ACCEPTED) / total elements; partial reported separately" },
    matchedLaw: stringList(analysis.matchedLaw, "matched law"),
    missingLaw: stringList(analysis.missingLaw, "missing law"),
    misappliedLaw: stringList(analysis.misappliedLaw, "misapplied law"),
    improvement: bounded(analysis.improvement, "improvement", 5000),
    decompositionRationale: bounded(analysis.decompositionRationale, "decomposition rationale", 5000),
    scoreRationale: bounded(analysis.scoreRationale, "score rationale", 5000),
    officialSourceDigest: sha256(source),
  };
}
