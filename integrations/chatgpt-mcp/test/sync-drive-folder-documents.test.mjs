import test from "node:test";
import assert from "node:assert/strict";
import { findCrossDocumentDuplicates, syncDriveFolderDocuments } from "../db/sync-drive-folder-documents.mjs";

class FakePool {
  constructor() { this.ended = false; }
  async query(sql) {
    if (sql.includes("FROM document_folders")) return { rows: [
      { folderId: "folder-1", subjectId: "CIVIL", stage: "P1", enabled: true },
      { folderId: "folder-2", subjectId: "CIVIL", stage: "P2", enabled: true },
    ] };
    if (sql.includes("FROM document_registry")) return { rows: [] };
    if (sql.includes("FROM problems p")) return { rows: [] };
    throw new Error("unexpected query");
  }
  async connect() { return { release() {} }; }
  async end() { this.ended = true; }
}

const env = { DATABASE_URL: "postgresql://test:test@localhost/test" };
const doc = (documentId, driveVersion = "v1") => ({ documentId, title: "test",
  driveVersion, sizeBytes: 100 });
const snapshotParser = (_document, sourceId) => ({ documentId: "new-doc", sourceId,
  revisionId: "r1", contentDigest: "digest", problems: [{ stableKey: `${sourceId}|Q1` }] });

test("per-document parser failure does not stop another document", async () => {
  const failed = [];
  const recorded = [];
  const result = await syncDriveFolderDocuments({ env, Pool: FakePool,
    tokenProvider: async () => "token",
    listFiles: async (folderId) => folderId === "folder-1" ? [doc("bad-doc"), doc("good-doc")] : [],
    register: async (_client, file) => ({ sourceId: `SRC-CIV-AUTO-${file.documentId}`, status: "DISCOVERED" }),
    fetchDocument: async ({ documentId }) => ({ documentId }),
    snapshotParser: (document, sourceId) => {
      if (document.documentId === "bad-doc") throw new Error("bad source format");
      return snapshotParser(document, sourceId);
    },
    detect: async () => ({ counts: { NEW: 1 }, candidates: [] }),
    record: async (_client, id) => recorded.push(id),
    recordFailure: async (_client, id) => failed.push(id),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(failed, ["bad-doc"]);
  assert.deepEqual(recorded, ["good-doc"]);
});

test("only NEW candidates auto-stage; MODIFIED remains pending", async () => {
  const applied = [];
  const result = await syncDriveFolderDocuments({ env, Pool: FakePool,
    tokenProvider: async () => "token",
    listFiles: async (folderId) => folderId === "folder-1" ? [doc("new-doc")] : [],
    register: async () => ({ sourceId: "SRC-CIV-AUTO-abc", status: "DISCOVERED" }),
    fetchDocument: async () => ({ documentId: "new-doc" }), snapshotParser,
    detect: async () => ({ counts: { NEW: 1, MODIFIED: 1 }, candidates: [
      { candidate_kind: "NEW", state: "PENDING", candidate_id: "candidate-new" },
      { candidate_kind: "MODIFIED", state: "PENDING", candidate_id: "candidate-modified" },
    ] }),
    apply: async (_pool, input) => applied.push(input), record: async () => {},
  });
  assert.equal(result.ok, true);
  assert.deepEqual(applied.map((item) => item.candidateId), ["candidate-new"]);
  assert.equal(applied[0].autoStageNew, true);
  assert.equal(result.appliedToPublishedBank, false);
});

test("cross-document duplicate is recorded for review before detect or staging", async () => {
  let recorded;
  const result = await syncDriveFolderDocuments({ env, Pool: FakePool,
    tokenProvider: async () => "token",
    listFiles: async (folderId) => folderId === "folder-1" ? [doc("duplicate-doc")] : [],
    register: async () => ({ sourceId: "SRC-CIV-AUTO-abc", status: "DISCOVERED" }),
    fetchDocument: async () => ({ documentId: "duplicate-doc" }),
    snapshotParser: () => ({ ...snapshotParser({}, "SRC-CIV-AUTO-abc"),
      documentId: "duplicate-doc", revisionId: "r2" }),
    findDuplicates: async () => [{ stableKey: "SRC-CIV-AUTO-abc|Q1" }],
    detect: async () => { throw new Error("duplicate must not be detected as new"); },
    apply: async () => { throw new Error("duplicate must not be staged"); },
    record: async (_client, _id, value) => { recorded = value; },
  });
  assert.equal(result.documents[0].status, "REVIEW");
  assert.equal(result.documents[0].code, "CROSS_DOCUMENT_DUPLICATE");
  assert.equal(recorded.status, "REVIEW");
  assert.equal(recorded.counts.CROSS_DOCUMENT_DUPLICATE, 1);
});

test("cross-document duplicate lookup matches raw ID and exact prompt digest", async () => {
  const queries = [];
  const pool = { query: async (sql, args) => {
    queries.push({ sql, args });
    return { rows: [{ stableKey: "SRC-CIV-004|Q1", promptDigest: "digest-a", documentId: "old" },
      { stableKey: "SRC-CIV-004B|Q2", promptDigest: "digest-b", documentId: "other" }] };
  } };
  const duplicates = await findCrossDocumentDuplicates(pool, { documentId: "new", problems: [
    { stableKey: "SRC-CIV-AUTO-new|Q1", promptDigest: "digest-b" },
  ] });
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].matchedKeys.length, 2);
  assert.deepEqual(queries[0].args, [["Q1"], ["digest-b"]]);
});

test("same prompt repeated inside new Doc is held for review", async () => {
  const pool = { query: async () => ({ rows: [] }) };
  const duplicates = await findCrossDocumentDuplicates(pool, { documentId: "new", problems: [
    { stableKey: "SRC-CIV-AUTO-new|Q1", promptDigest: "same" },
    { stableKey: "SRC-CIV-AUTO-new|Q2", promptDigest: "same" },
  ] });
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].kind, "WITHIN_DOCUMENT_DUPLICATE");
});

test("reviewed duplicate can be reparsed after correction while a moved file stays held", async () => {
  const parsed = [];
  const result = await syncDriveFolderDocuments({ env, Pool: FakePool,
    tokenProvider: async () => "token",
    listFiles: async (folderId) => folderId === "folder-1"
      ? [doc("corrected-doc"), doc("moved-doc")] : [],
    register: async (_client, file) => ({ sourceId: "SRC-CIV-AUTO-abc", status: "REVIEW",
      reviewReason: file.documentId === "moved-doc" ? "FOLDER_MOVE" : null }),
    fetchDocument: async ({ documentId }) => { parsed.push(documentId); return { documentId }; },
    snapshotParser,
    detect: async () => ({ counts: { NEW: 0 }, candidates: [] }),
    record: async () => {},
  });
  assert.deepEqual(parsed, ["corrected-doc"]);
  assert.equal(result.documents.find((item) => item.documentId === "corrected-doc").status, "STAGED");
  assert.equal(result.documents.find((item) => item.documentId === "moved-doc").status, "REVIEW");
});

test("unchanged Drive version skips Docs fetch and parser", async () => {
  const result = await syncDriveFolderDocuments({ env, Pool: FakePool,
    tokenProvider: async () => "token",
    listFiles: async (folderId) => folderId === "folder-1" ? [doc("known-doc")] : [],
    register: async () => ({ sourceId: "SRC-CIV-AUTO-abc", status: "STAGED",
      lastSyncedDriveVersion: "v1" }),
    fetchDocument: async () => { throw new Error("unnecessary fetch"); },
  });
  assert.equal(result.documents[0].status, "UNCHANGED");
});

test("large Docs produces next-file warning without changing publication", async () => {
  let recorded;
  const result = await syncDriveFolderDocuments({
    env: { ...env, GOOGLE_DOC_WARNING_BYTES: "1000" }, Pool: FakePool,
    tokenProvider: async () => "token",
    listFiles: async (folderId) => folderId === "folder-1"
      ? [{ ...doc("large-doc"), sizeBytes: 1001 }] : [],
    register: async () => ({ sourceId: "SRC-CIV-AUTO-abc", status: "DISCOVERED" }),
    fetchDocument: async () => ({ documentId: "large-doc" }), snapshotParser,
    detect: async () => ({ counts: { NEW: 0 }, candidates: [] }),
    record: async (_client, _id, details) => { recorded = details; },
  });
  assert.equal(result.documents[0].capacityWarning, true);
  assert.match(result.documents[0].guidance, /next Google Doc/);
  assert.equal(recorded.counts.capacityWarning, true);
  assert.equal(result.appliedToPublishedBank, false);
});

test("failed folder scan suppresses missing-document review", async () => {
  const result = await syncDriveFolderDocuments({ env, Pool: FakePool,
    tokenProvider: async () => "token",
    listFiles: async (folderId) => {
      if (folderId === "folder-2") throw new Error("permission denied");
      return [];
    },
    markMissing: async () => { throw new Error("must not mark missing"); },
  });
  assert.equal(result.folderErrors.length, 1);
  assert.equal(result.missingReview, 0);
});

test("same file in two folders is never registered or staged", async () => {
  const result = await syncDriveFolderDocuments({ env, Pool: FakePool,
    tokenProvider: async () => "token",
    listFiles: async () => [doc("shared-doc")],
    register: async () => { throw new Error("must not register ambiguous file"); },
  });
  assert.deepEqual(result.documents, [{ documentId: "shared-doc", status: "REVIEW",
    code: "MULTIPLE_FOLDERS" }]);
});

test("partial unpublished NEW staging resumes pending candidate on replay", async () => {
  const applied = new Set();
  let failedOnce = false;
  let status = "DISCOVERED";
  let driveVersion = null;
  const options = { env, Pool: FakePool,
    tokenProvider: async () => "token",
    listFiles: async (folderId) => folderId === "folder-1" ? [doc("new-doc")] : [],
    register: async () => ({ sourceId: "SRC-CIV-AUTO-abc", status,
      lastSyncedDriveVersion: driveVersion }),
    fetchDocument: async () => ({ documentId: "new-doc" }), snapshotParser,
    detect: async () => ({ counts: { NEW: 2 }, candidates: ["first", "second"].map((id) => ({
      candidate_id: id, candidate_kind: "NEW", state: applied.has(id) ? "APPLIED" : "PENDING" })) }),
    apply: async (_pool, input) => {
      if (input.candidateId === "second" && !failedOnce) { failedOnce = true; throw new Error("retryable"); }
      applied.add(input.candidateId);
    },
    recordFailure: async () => { status = "ERROR"; },
    record: async () => { status = "STAGED"; driveVersion = "v1"; },
  };
  const first = await syncDriveFolderDocuments(options);
  assert.equal(first.documents[0].status, "ERROR");
  assert.deepEqual([...applied], ["first"]);
  const second = await syncDriveFolderDocuments(options);
  assert.equal(second.documents[0].status, "STAGED");
  assert.deepEqual([...applied], ["first", "second"]);
  assert.equal(driveVersion, "v1");
});
