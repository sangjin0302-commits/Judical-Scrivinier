import { createP2CriteriaManifest } from "./p2-fixed-criteria.mjs";

function canonicalManifest(manifest, source) {
  if (manifest?.version !== "p2-fixed-criteria-v1") throw new Error("fixed manifest required");
  const canonical = createP2CriteriaManifest(manifest.requiredElements, source);
  if (manifest.criteriaDigest !== canonical.criteriaDigest ||
      manifest.officialSourceDigest !== canonical.officialSourceDigest) {
    throw new Error("fixed manifest provenance mismatch");
  }
  return canonical;
}

// IDs are scoped to criteriaDigest. Models return judgments, never regenerate
// authoritative source excerpts or change the denominator.
export function createP2EvaluationCatalog(manifest, source) {
  const canonical = canonicalManifest(manifest, source);
  return { criteriaDigest: canonical.criteriaDigest,
    elements: canonical.requiredElements.map((element, i) =>
      ({ elementId: `element-${i + 1}`, ...element })) };
}

export function bindP2ElementEvaluations(manifest, result, source) {
  const catalog = createP2EvaluationCatalog(manifest, source);
  if (result?.criteriaDigest !== catalog.criteriaDigest || !Array.isArray(result.elements) ||
      result.elements.length !== catalog.elements.length) {
    throw new Error("evaluation manifest or element count mismatch");
  }
  const expected = new Map(catalog.elements.map(e => [e.elementId, e]));
  const judgments = new Map();
  const allowed = new Set(["elementId", "status", "answerExcerpt", "explanation", "alternativeSourceRef"]);
  for (const judgment of result.elements) {
    if (!judgment || typeof judgment !== "object" || Array.isArray(judgment) ||
        !expected.has(judgment.elementId) || judgments.has(judgment.elementId)) {
      throw new Error("duplicate or unknown evaluation element ID");
    }
    if (Object.keys(judgment).some(key => !allowed.has(key))) {
      throw new Error("model supplied authoritative or unsupported element field");
    }
    judgments.set(judgment.elementId, judgment);
  }
  const elements = catalog.elements.map(({ elementId, ...trusted }) => {
    const { elementId: ignored, ...judgment } = judgments.get(elementId);
    return { ...trusted, ...judgment };
  });
  // Existing buildP2SemanticAudit remains mandatory after binding: it validates
  // statuses, original-answer evidence, diagnostics and arithmetic.
  return { elements, matchedLaw: result.matchedLaw, missingLaw: result.missingLaw,
    misappliedLaw: result.misappliedLaw, improvement: result.improvement,
    decompositionRationale: result.decompositionRationale, scoreRationale: result.scoreRationale };
}
