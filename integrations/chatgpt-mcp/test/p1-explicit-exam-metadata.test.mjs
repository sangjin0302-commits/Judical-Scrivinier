import test from "node:test";
import assert from "node:assert/strict";
import { validateP1ExamMetadata, verifyP1SourceRevisions,
  reconcileP1ExamMetadata } from "../db/p1-explicit-exam-metadata.mjs";

const record = { stableKey: "SRC-CIV-004|verified-1", sourceId: "SRC-CIV-004",
  year: "2026", session: "1", questionNumber: "2" };
function fakeClient(metadata = { sourceId: record.sourceId }, stage = "P1") {
  const calls = [];
  return { calls, async query(sql) {
    calls.push(sql);
    if (sql.includes("SELECT stable_key,stage")) return { rowCount: 1,
      rows: [{ stable_key: record.stableKey, stage, selection_metadata: metadata }] };
    if (sql.includes("UPDATE problems")) return { rowCount: 1, rows: [] };
    return { rowCount: 0, rows: [] };
  } };
}

test("only explicit source-backed metadata accepted; ambiguous session excluded", () => {
  assert.deepEqual(validateP1ExamMetadata({ records: [record] }), [record]);
  assert.throws(() => validateP1ExamMetadata({ records: [record, record] }), /duplicate/);
  assert.throws(() => validateP1ExamMetadata({ records: [{ ...record, session: "3" }] }), /invalid/);
  assert.throws(() => validateP1ExamMetadata({ records: [{ ...record, sourceId: "SRC-CIV-005" }] }), /invalid/);
});

test("apply requires exact current Google Docs revisions", () => {
  const data = { sourceDocs: { "SRC-CIV-004": "id1", "SRC-CIV-004B": "id2" },
    sourceRevisions: { "SRC-CIV-004": "a".repeat(30), "SRC-CIV-004B": "b".repeat(30) } };
  assert.equal(verifyP1SourceRevisions(data, data.sourceRevisions), true);
  assert.throws(() => verifyP1SourceRevisions(data,
    { ...data.sourceRevisions, "SRC-CIV-004B": "changed" }), /revision changed/);
});

test("dry run reports pending but never writes; apply changes only JSON metadata", async () => {
  const dry = fakeClient();
  assert.deepEqual(await reconcileP1ExamMetadata(dry, [record]),
    { ok: true, applied: false, sourceBacked: 1, alreadyMapped: 0, pending: 1, changed: 0 });
  assert.ok(dry.calls[0].includes("READ ONLY"));
  assert.ok(!dry.calls.some((sql) => sql.includes("UPDATE problems")));
  const apply = fakeClient();
  const result = await reconcileP1ExamMetadata(apply, [record], { apply: true });
  assert.equal(result.changed, 1);
  assert.ok(apply.calls.some((sql) => sql.includes("UPDATE problems AS p SET selection_metadata")));
});

test("conflicting existing metadata rolls back before mutation", async () => {
  const client = fakeClient({ sourceId: record.sourceId, year: "2025" });
  await assert.rejects(reconcileP1ExamMetadata(client, [record], { apply: true }), /conflicts/);
  assert.ok(client.calls.includes("ROLLBACK"));
  assert.ok(!client.calls.some((sql) => sql.includes("UPDATE problems")));
});
