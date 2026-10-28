import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { decryptGradingPayload, gradingKey } from "../db/postgres-adapter.mjs";

test("grading key is never generated when the configured key is missing", () => {
  assert.throws(() => gradingKey({}), /GRADING_KEY_BASE64 is required/);
  assert.throws(() => gradingKey({ GRADING_KEY_BASE64: Buffer.alloc(31).toString("base64") }), /32 bytes/);
});

test("AES-256-GCM payloads decrypt only with the transferred key", () => {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify({ answer: "O" })), cipher.final()]);
  const encrypted = Buffer.concat([iv, cipher.getAuthTag(), body]);
  assert.deepEqual(decryptGradingPayload(encrypted, key), { answer: "O" });
  assert.throws(() => decryptGradingPayload(encrypted, crypto.randomBytes(32)));
});
