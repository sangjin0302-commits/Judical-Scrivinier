import { classifyDocumentSnapshot, fetchGoogleDocReadOnly, normalizeDocumentSnapshot, sha256 } from "./google-docs-sync.mjs";
import { parseP1Document, parseP2Document } from "./google-docs-parser.mjs";

const SOURCES = new Map([
  ["SRC-CIV-004", parseP1Document],
  ["SRC-CIV-004B", parseP1Document],
  ["SRC-CIV-005", parseP2Document],
]);

// Docs holds prompt text. Official answers and grading keys must arrive through a
// separate verified maintenance path; never infer them from the question document.
export function snapshotFromGoogleDoc(document, sourceId) {
  const parser = SOURCES.get(sourceId);
  if (!parser) throw new Error("unapproved Google Docs source");
  const parsed = parser(document, sourceId);
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

export async function fetchGoogleDocsSnapshotReadOnly({ documentId, sourceId, accessToken, fetchImpl }) {
  const document = await fetchGoogleDocReadOnly({ documentId, accessToken, fetchImpl });
  return snapshotFromGoogleDoc(document, sourceId);
}

// Diagnostic only. Existing baseline rows often have a Sheets sourceVersion and
// no Docs source map, so metadata-only candidates need explicit baseline review.
export function dryRunGoogleDocsCandidates(snapshot, currentProblems = []) {
  const candidates = classifyDocumentSnapshot(snapshot.problems, currentProblems, snapshot.documentId);
  const counts = Object.fromEntries(["NEW", "MODIFIED", "UNCHANGED", "DUPLICATE", "DELETE_CANDIDATE"]
    .map((kind) => [kind, candidates.filter((item) => item.kind === kind).length]));
  return {
    readOnly: true,
    documentId: snapshot.documentId,
    revisionId: snapshot.revisionId,
    parsedUnique: snapshot.problems.length,
    counts,
    promptModified: candidates.filter((item) => item.kind === "MODIFIED" && item.promptChanged).length,
    metadataOnlyModified: candidates.filter((item) => item.kind === "MODIFIED" && !item.promptChanged &&
      !item.answerChanged && !item.explanationChanged).length,
    needsReview: candidates.some((item) => item.kind !== "UNCHANGED"),
  };
}
