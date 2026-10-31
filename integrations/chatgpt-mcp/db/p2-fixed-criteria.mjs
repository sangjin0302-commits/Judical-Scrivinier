import { createHash } from "node:crypto";

const clean = value => String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
const hash = value => createHash("sha256").update(value, "utf8").digest("hex");
const categories = new Set(["ISSUE", "LAW", "ELEMENT", "PRECEDENT", "APPLICATION", "CONCLUSION"]);
const identity = value => clean(value).toLocaleLowerCase("ko-KR");

// Creating a manifest is NOT approval or publication.
// Callers must hold this manifest fixed before evaluating any candidate answers.
export function createP2CriteriaManifest(requiredElements, { modelAnswer, rubric } = {}) {
  const source = clean(`${modelAnswer || ""} ${rubric || ""}`);
  if (!source) throw new Error("official source required");
  if (!Array.isArray(requiredElements) || requiredElements.length < 1 || requiredElements.length > 30) {
    throw new Error("invalid fixed criteria");
  }
  const seen = new Set();
  const elements = requiredElements.map(element => {
    const category = clean(element?.category);
    const criterion = clean(element?.criterion);
    const modelExcerpt = clean(element?.modelExcerpt);
    if (!categories.has(category) || !criterion || criterion.length > 500 ||
        !modelExcerpt || modelExcerpt.length > 2000 || !source.includes(modelExcerpt)) {
      throw new Error("invalid fixed criterion or official evidence");
    }
    const key = identity(criterion);
    if (seen.has(key)) throw new Error("duplicate fixed criterion");
    seen.add(key);
    return { category, criterion, modelExcerpt };
  }).sort((a, b) => identity(a.criterion) < identity(b.criterion) ? -1 : 1);
  const officialSourceDigest = hash(source);
  const version = "p2-fixed-criteria-v1";
  return { version, officialSourceDigest, requiredElements: elements,
    criteriaDigest: hash(JSON.stringify({ version, officialSourceDigest, requiredElements: elements })) };
}

// Checks decomposition only. Status/evidence/score validation remains the existing
// buildP2SemanticAudit contract. Runtime callers load the manifest from the
// encrypted key snapshot, never from the submitted evaluation.
export function validateP2FixedCriteria(manifest, analysis, source) {
  if (!manifest || manifest.version !== "p2-fixed-criteria-v1") throw new Error("fixed criteria manifest required");
  const canonical = createP2CriteriaManifest(manifest.requiredElements, source);
  if (manifest.officialSourceDigest !== canonical.officialSourceDigest ||
      manifest.criteriaDigest !== canonical.criteriaDigest) {
    throw new Error("fixed criteria source or digest mismatch");
  }
  const supplied = createP2CriteriaManifest(analysis?.elements, source);
  if (supplied.criteriaDigest !== canonical.criteriaDigest) {
    throw new Error("evaluation criteria differ from fixed manifest");
  }
  return { criteriaDigest: canonical.criteriaDigest,
    officialSourceDigest: canonical.officialSourceDigest,
    requiredElementCount: canonical.requiredElements.length };
}

function boundedRule(value, maximum, empty = false) {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > maximum) {
    throw new Error("invalid fixed decision rule");
  }
  return value;
}
function boundedRuleList(value) {
  if (!Array.isArray(value) || value.length > 30) throw new Error("invalid fixed decision rule list");
  return value.map(item => boundedRule(item, 2000));
}
export function validateP2DecisionRubric(rubric, manifest, officialSource) {
  validateP2FixedCriteria(manifest, { elements: rubric?.elements }, officialSource);
  return {
    elements: rubric.elements.map(element => ({
      category: boundedRule(element.category, 30), criterion: boundedRule(element.criterion, 500),
      modelExcerpt: boundedRule(element.modelExcerpt, 2000), explanation: boundedRule(element.explanation, 5000),
      requiredPropositions: boundedRuleList(element.requiredPropositions),
      matchCondition: boundedRule(element.matchCondition, 5000), partialCondition: boundedRule(element.partialCondition, 5000),
      errorCondition: boundedRule(element.errorCondition, 5000), missingCondition: boundedRule(element.missingCondition, 5000),
    })),
    decompositionRationale: boundedRule(rubric.decompositionRationale, 5000),
    changesFromPrevious: boundedRule(rubric.changesFromPrevious, 5000, true),
    unresolvedAmbiguities: boundedRuleList(rubric.unresolvedAmbiguities),
  };
}

// Publication evidence is loaded only from the authenticated encrypted key snapshot.
// This verifies its binding; it does not certify the legal correctness of a review.
export function validateP2ApprovedSource(payload, snapshot) {
  const source = { modelAnswer: payload.answer, rubric: payload.rubric };
  const manifest = payload.fixedCriteriaManifest;
  validateP2FixedCriteria(manifest, { elements: manifest?.requiredElements }, source);
  const decision = validateP2DecisionRubric(payload.fixedDecisionRubric, manifest, source);
  if (decision.unresolvedAmbiguities.length !== 0) {
    throw new Error("fixed decision rubric has unresolved ambiguities");
  }
  const review = payload.fixedCriteriaReviewEvidence;
  const approval = payload.fixedCriteriaApproval;
  const stable = value => Array.isArray(value) ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  const digest = value => hash(JSON.stringify(stable(value)));
  const nonempty = value => typeof value === "string" && value.trim().length > 0;
  const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  if (review?.sourceOnly !== true || review.learnerAnswersProvidedToRubricReview !== false ||
      review.duplicateGroups !== 0 || review.unsupportedElements !== 0 || review.requiresRevision !== false ||
      !nonempty(review.criteriaFile) || !hex(review.criteriaFileDigest) ||
      !nonempty(review.auditFile) || !hex(review.auditFileDigest)) {
    throw new Error("approved source-only review required");
  }
  if (!approval || !nonempty(approval.reviewId) || !nonempty(approval.reviewerId) ||
      !nonempty(approval.reviewedAt) || !Number.isFinite(Date.parse(approval.reviewedAt)) ||
      !nonempty(approval.originalKeyVersion) || !nonempty(approval.originalEncryptionKeyId) ||
      !hex(approval.originalPayloadDigest) ||
      !nonempty(snapshot?.problemVersionId) || !hex(snapshot?.problemDigest) ||
      approval.problemVersionId !== snapshot.problemVersionId || approval.problemDigest !== snapshot.problemDigest ||
      approval.criteriaDigest !== manifest.criteriaDigest ||
      approval.decisionRubricDigest !== digest(decision) || approval.reviewEvidenceDigest !== digest(review)) {
    throw new Error("fixed criteria approval snapshot binding mismatch");
  }
  return { criteriaDigest: manifest.criteriaDigest, problemVersionId: snapshot.problemVersionId };
}
