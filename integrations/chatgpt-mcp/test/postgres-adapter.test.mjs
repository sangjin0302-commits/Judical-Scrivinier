import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { createPostgresExecutor, decryptGradingPayload, gradingAad, gradingKey } from "../db/postgres-adapter.mjs";

test("grading key is never generated when the configured key is missing", () => {
  assert.throws(() => gradingKey({}), /GRADING_KEY_BASE64 is required/);
  assert.throws(() => gradingKey({ GRADING_KEY_BASE64: Buffer.alloc(31).toString("base64") }), /32 bytes/);
});

test("new issue sets snapshot exact grading key version and encryption key id", async () => {
  const itemInserts = [];
  const advisoryLocks = [];
  const candidates = Array.from({ length: 10 }, (_, index) => ({
    stable_key: `p-${index + 1}`,
    prompt_text: `question ${index + 1}`,
    max_points: null,
    source_version: "source-v1",
    selection_metadata: {},
    grading_key_version: "source-v1",
    grading_encryption_key_id: "key-v2",
  }));
  const client = {
    async query(sql, values = []) {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rowCount: 0, rows: [] };
      if (sql.includes("pg_advisory_xact_lock")) advisoryLocks.push(values[0]);
      if (sql.includes("FROM issue_sets") && sql.includes("request_id")) return { rowCount: 0, rows: [] };
      if (sql.includes("FROM problems p JOIN private_grading_keys")) return { rowCount: 10, rows: candidates };
      if (sql.includes("INSERT INTO issue_set_items")) itemInserts.push(values);
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const execute = createPostgresExecutor({
    pool: { connect: async () => client },
    env: { GRADING_ENCRYPTION_KEY_ID: "key-v2" },
  });
  const result = await execute("issueCivilP1", { requestId: "snapshot-1", mode: "전범위" }, { ownerId: "user-1" });
  assert.equal(result.count, 10);
  assert.equal(itemInserts.length, 10);
  assert.equal(advisoryLocks.length, 1);
  assert.match(advisoryLocks[0], /^[0-9a-f]{64}$/);
  assert.ok(itemInserts.every((values) => values[4] === "source-v1" && values[5] === "key-v2"));
});

test("AES-256-GCM payloads decrypt only with the transferred key", () => {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const aad = gradingAad("CIVIL", "problem-1", "source-v1", "key-v2");
  const plaintext = JSON.stringify({ answer: "O" });
  const payloadDigest = crypto.createHash("sha256").update(plaintext).digest("hex");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const encrypted = Buffer.concat([iv, cipher.getAuthTag(), body]);
  assert.deepEqual(decryptGradingPayload(encrypted, key, aad, payloadDigest), { answer: "O" });
  assert.throws(() => decryptGradingPayload(encrypted, crypto.randomBytes(32), aad, payloadDigest));
  assert.throws(() => decryptGradingPayload(encrypted, key,
    gradingAad("CIVIL", "problem-2", "source-v1", "key-v2"), payloadDigest));
  assert.throws(() => decryptGradingPayload(encrypted, key, aad, "0".repeat(64)), /digest mismatch/);
});
