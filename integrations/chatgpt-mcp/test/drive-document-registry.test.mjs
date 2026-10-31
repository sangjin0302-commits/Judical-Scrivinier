import test from "node:test";
import assert from "node:assert/strict";
import {
  listFolderDocuments, discoverFolderDocuments, registerDiscoveredDocument,
  markMissingDocumentForReview, missingManagedDocuments, crossDocumentDuplicateCandidates,
} from "../db/drive-document-registry.mjs";

const folderId = "1z17WoYz5pAo--l3EBpdE1AeTV6sQALl1";
const documentId = "169rzZ3qlM-LfZI7I6gCSwWEeJ4Cc8RiHZzH9Qm_dwys";
const file = { documentId, title: "new source", folderId, subjectId: "CIVIL", stage: "P1" };

test("Drive discovery consumes every provider page without content fetch", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    calls.push(parsed);
    return { ok: true, json: async () => parsed.searchParams.has("pageToken")
      ? { files: [{ id: documentId + "B", name: "second", mimeType: "application/vnd.google-apps.document" }] }
      : { nextPageToken: "next", files: [{ id: documentId, name: "first", mimeType: "application/vnd.google-apps.document" }] } };
  };
  const files = await listFolderDocuments(folderId, "test-token", fetchImpl);
  assert.equal(files.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].searchParams.get("pageToken"), "next");
  assert.match(calls[0].searchParams.get("q"), /trashed = false/);
});

test("Drive duplicate physical file in two configured folders fails closed", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ files: [
    { id: documentId, name: "same", mimeType: "application/vnd.google-apps.document" }] }) });
  await assert.rejects(discoverFolderDocuments([
    { folderId, subjectId: "CIVIL", stage: "P1", enabled: true },
    { folderId: "1AEZaBXBYXJHnzWblaWMfEPET3LXT80Bs", subjectId: "CIVIL", stage: "P2", enabled: true },
  ], "test-token", fetchImpl), /multiple/);
});

test("registry creates durable logical source ID and reuses it on replay", async () => {
  const queries = [];
  let stored;
  const client = { query: async (sql, values = []) => {
    queries.push(sql);
    if (sql.startsWith("SELECT 1 FROM document_folders")) return { rowCount: 1, rows: [{}] };
    if (sql.startsWith("SELECT source_id")) return stored
      ? { rowCount: 1, rows: [stored] } : { rowCount: 0, rows: [] };
    if (sql.includes("INSERT INTO document_registry(")) stored = {
      source_id: values[1], folder_id: folderId, registration_kind: "FOLDER",
      registration_status: "DISCOVERED" };
    return { rowCount: 1, rows: [] };
  } };
  const first = await registerDiscoveredDocument(client, file);
  const second = await registerDiscoveredDocument(client, file);
  assert.match(first.sourceId, /^SRC-CIV-AUTO-/);
  assert.equal(second.sourceId, first.sourceId);
  assert.equal(second.replayed, true);
  assert.equal(queries.filter((sql) => sql.includes("INSERT INTO document_registry(")).length, 1);
});

test("move and disappearance are held for review, never deleted", async () => {
  const queries = [];
  const client = { query: async (sql) => {
    queries.push(sql);
    if (sql.startsWith("SELECT 1 FROM document_folders")) return { rowCount: 1 };
    if (sql.startsWith("SELECT source_id")) return { rowCount: 1, rows: [{
      source_id: "SRC-CIV-AUTO-old", folder_id: "different-folder",
      registration_kind: "FOLDER", registration_status: "STAGED" }] };
    return { rowCount: 1, rows: [] };
  } };
  const moved = await registerDiscoveredDocument(client, file);
  assert.equal(moved.status, "REVIEW");
  assert.equal(await markMissingDocumentForReview(client, documentId), true);
  assert.equal(queries.some((sql) => /DELETE FROM/i.test(sql)), false);
});

test("same raw ID or prompt in another document requires duplicate review", () => {
  const result = crossDocumentDuplicateCandidates([
    { documentId: "new-doc", stableKey: "SRC-CIV-AUTO-x|Q1", promptDigest: "same" },
  ], [
    { documentId: "old-doc", stableKey: "SRC-CIV-004|Q1", promptDigest: "different" },
    { documentId: "other-doc", stableKey: "SRC-CIV-004B|Q2", promptDigest: "same" },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].matchedKeys.length, 2);
});

test("missing candidates require a complete multi-folder scan", () => {
  const registered = [
    { documentId: "kept", registrationKind: "EXTERNAL" },
    { documentId: "missing", registrationKind: "FOLDER" },
  ];
  assert.throws(() => missingManagedDocuments(registered, []), /complete/);
  assert.deepEqual(missingManagedDocuments(registered, [], { completeScan: true }), ["missing"]);
});
