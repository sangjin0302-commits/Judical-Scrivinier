import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyPreparedP2 } from "../db/verify-p2-prepared-readonly.mjs";
import { gradingAad } from "../db/postgres-adapter.mjs";

test("real-answer audit decrypts only prepared submitted item and emits counts", async () => {
  const stableKey = "SYNTHETIC-P2-1";
  const key = crypto.randomBytes(32);
  const payload = JSON.stringify({ answer: "공식 법리", rubric: "쟁점과 결론" });
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(gradingAad("CIVIL", stableKey, "v1", "test-key"));
  const encrypted = Buffer.concat([nonce, cipher.update(payload, "utf8"), cipher.final(), cipher.getAuthTag()]);
  // The production framing is nonce, tag, ciphertext.
  const framed = Buffer.concat([nonce, cipher.getAuthTag(), encrypted.subarray(12, encrypted.length - 16)]);
  const statements = [];
  const client = { async query(sql) {
    statements.push(sql);
    if (sql.includes("FROM p2_grades")) return { rowCount: 0, rows: [] };
    if (sql.startsWith("SELECT")) return { rowCount: 1, rows: [{ submission_id: "synthetic-id",
      stable_key: stableKey, answer_text: "모르겠다.", max_points: 20,
      key_version: "v1", encryption_key_id: "test-key",
      encrypted_payload: framed, payload_digest: crypto.createHash("sha256").update(payload).digest("hex") }] };
    return { rowCount: 0, rows: [] };
  } };
  const result = await verifyPreparedP2(client, { GRADING_KEY_BASE64: key.toString("base64"),
    GRADING_ENCRYPTION_KEY_ID: "test-key" });
  assert.deepEqual(result, { readOnly: true, submittedPreparedItems: 1, abstentions: 1,
    abstentionZeroScoreVerified: 1,
    officialSourceVerified: 1, unavailableKeyGeneration: 0,
    committedWithOriginal: 0, committedNonAbstention: 0, committedVerifiedSourceAvailable: 0 });
  assert.equal(statements[0], "BEGIN READ ONLY");
  assert.equal(statements.at(-1), "COMMIT");
  assert.equal(statements.some(sql => /INSERT|UPDATE|DELETE|FOR UPDATE/i.test(sql)), false);
  assert.equal(JSON.stringify(result).includes("공식 법리"), false);
});
