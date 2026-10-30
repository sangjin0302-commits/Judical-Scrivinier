import { classifyDocumentSnapshot, fetchGoogleDocReadOnly, normalizeDocumentSnapshot, sha256 } from "./google-docs-sync.mjs";
import { normalizedPrompt, parseP1Document, parseP2Document } from "./google-docs-parser.mjs";

const SOURCES = new Map([
  ["SRC-CIV-004", parseP1Document],
  ["SRC-CIV-004B", parseP1Document],
  ["SRC-CIV-005", parseP2Document],
]);

// Docs holds prompt text. Official answers and grading keys must arrive through a
// separate verified maintenance path; never infer them from the question document.
export function snapshotFromGoogleDoc(document, sourceId, stage = null) {
  const registeredStage = /^SRC-CIV-AUTO-[a-f0-9]{32}$/.test(sourceId) ? stage : null;
  const parser = SOURCES.get(sourceId) ||
    (registeredStage === "P1" ? parseP1Document : registeredStage === "P2" ? parseP2Document : null);
  if (!parser) throw new Error("unapproved Google Docs source");
  const parsed = parser(document, sourceId);
  if (registeredStage && parsed.problems.length === 0) {
    throw new Error("no official problems recognized in registered Google Doc");
  }
  if (parsed.conflictingKeys.length) throw new Error("conflicting duplicate stable keys in Google Doc");
  const problems = parsed.problems.map((problem) => ({
    stableKey: problem.stableKey,
    sourceLocator: problem.sourceLocator,
    sourceVersion: "docs:" + sha256({ promptDigest: problem.promptDigest,
      stage: problem.stage, maxPoints: problem.maxPoints, sourceOrder: problem.sourceOrder }),
    sourceOrder: problem.sourceOrder,
    stage: problem.stage,
    unitId: null,
    promptText: problem.promptText,
    maxPoints: problem.maxPoints,
    selectionMetadata: {},
    gradingFieldsKnown: false,
    metadataFieldsKnown: false,
  }));
  return normalizeDocumentSnapshot({
    documentId: document.documentId,
    sourceId,
    title: document.title || sourceId,
    revisionId: document.revisionId,
    parserVersion: "google-docs-parser-v1",
    contentDigest: sha256(document.tabs?.length ? document.tabs : document.body),
    problems,
  });
}

export async function fetchGoogleDocsSnapshotReadOnly({ documentId, sourceId, stage = null, accessToken, fetchImpl }) {
  const document = await fetchGoogleDocReadOnly({ documentId, accessToken, fetchImpl });
  return snapshotFromGoogleDoc(document, sourceId, stage);
}

// Diagnostic only. Existing baseline rows often have a Sheets sourceVersion and
// no Docs source map, so metadata-only candidates need explicit baseline review.
export function dryRunGoogleDocsCandidates(snapshot, currentProblems = []) {
  const candidates = classifyDocumentSnapshot(snapshot.problems, currentProblems, snapshot.documentId);
  const duplicateKeys = new Set(candidates.filter((item) => item.kind === "DUPLICATE")
    .map((item) => item.payload.duplicateStableKey));
  const currentByKey = new Map(currentProblems.map((problem) => [problem.stableKey, problem]));
  const counts = { NEW: 0, MODIFIED: 0, UNCHANGED: 0, DUPLICATE: 0, DELETE_CANDIDATE: 0 };
  let normalizedOnly = 0;
  let baselineMetadataOnly = 0;
  for (const next of snapshot.problems) {
    if (duplicateKeys.has(next.stableKey)) { currentByKey.delete(next.stableKey); continue; }
    const prior = currentByKey.get(next.stableKey);
    if (!prior) { counts.NEW += 1; continue; }
    currentByKey.delete(next.stableKey);
    const exactPrompt = next.promptDigest === prior.promptDigest;
    const samePrompt = exactPrompt || (prior.promptText != null &&
      normalizedPrompt(next.promptText) === normalizedPrompt(prior.promptText));
    const materialChange = !samePrompt || next.stage !== prior.stage ||
      Number(next.maxPoints ?? 0) !== Number(prior.maxPoints ?? 0);
    if (materialChange) counts.MODIFIED += 1;
    else {
      counts.UNCHANGED += 1;
      if (!exactPrompt) normalizedOnly += 1;
      if (next.sourceVersion !== prior.sourceVersion || next.sourceLocator !== prior.sourceLocator ||
          Number(next.sourceOrder) !== Number(prior.sourceOrder)) baselineMetadataOnly += 1;
    }
  }
  counts.DELETE_CANDIDATE = currentByKey.size;
  counts.DUPLICATE = candidates.filter((item) => item.kind === "DUPLICATE").length;
  return {
    readOnly: true,
    documentId: snapshot.documentId,
    revisionId: snapshot.revisionId,
    parsedUnique: snapshot.problems.length,
    counts,
    promptModified: counts.MODIFIED,
    normalizedOnly,
    baselineMetadataOnly,
    needsReview: counts.NEW + counts.MODIFIED + counts.DUPLICATE + counts.DELETE_CANDIDATE > 0,
  };
}
