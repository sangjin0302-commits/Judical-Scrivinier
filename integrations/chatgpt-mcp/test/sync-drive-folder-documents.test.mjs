import test from "node:test";
import assert from "node:assert/strict";
import { syncDriveFolderDocuments } from "../db/sync-drive-folder-documents.mjs";

class FakePool {
  constructor() { this.ended = false; }
  async query(sql) {
    if (sql.includes("FROM document_folders")) return { rows: [
      { folderId: "folder-1", subjectId: "CIVIL", stage: "P1", enabled: true },
      { folderId: "folder-2", subjectId: "CIVIL", stage: "P2", enabled: true },
    ] };
    if (sql.includes("FROM document_registry")) return { rows: [] };
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
