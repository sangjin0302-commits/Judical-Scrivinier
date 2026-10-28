import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { postgresConnectionOptions } from "./pg-connection.mjs";

export async function reencryptGradingKeys(env = process.env) {
function required(value, name) {
  const result = String(value || "").trim();
  if (!result) throw new Error(`${name} is required`);
  return result;
}
const SUBJECT = "CIVIL";
const EXPECTED = 9445;
const APPROVED_TEST_SPREADSHEET_ID = "1M9z2tgrsIbj1PdVKBnzwyyMFXdWNKj7VBtOShk_CBnQ";
const keyId = required(env.GRADING_ENCRYPTION_KEY_ID, "GRADING_ENCRYPTION_KEY_ID");
const encryptionKey = Buffer.from(required(env.GRADING_KEY_BASE64, "GRADING_KEY_BASE64"), "base64");
if (encryptionKey.length !== 32) throw new Error("GRADING_KEY_BASE64 must decode to 32 bytes");
try {
const sha = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const spreadsheetId = required(env.TEST_SPREADSHEET_ID, "TEST_SPREADSHEET_ID");
if (spreadsheetId !== APPROVED_TEST_SPREADSHEET_ID) {
  throw new Error("only the approved independent test spreadsheet is allowed");
}

const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: required(env.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID"),
    client_secret: required(env.GOOGLE_CLIENT_SECRET, "GOOGLE_CLIENT_SECRET"),
    refresh_token: required(env.GOOGLE_REFRESH_TOKEN, "GOOGLE_REFRESH_TOKEN"),
    grant_type: "refresh_token",
  }),
});
const token = await tokenResponse.json();
if (!tokenResponse.ok || !token.access_token) throw new Error("Google OAuth refresh failed");

const sheetsHeaders = { authorization: `Bearer ${token.access_token}` };
async function googleFailure(response, operation) {
  const body = await response.json().catch(() => ({}));
  const reason = body?.error?.details?.[0]?.reason || body?.error?.errors?.[0]?.reason || body?.error?.status || "unknown";
  throw new Error(`${operation} failed: ${response.status} ${reason}`);
}
async function sheetsFetch(url, operation) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(url, { headers: sheetsHeaders });
    if (response.ok) return response;
    if (response.status !== 429 || attempt === 4) await googleFailure(response, operation);
    const retryAfter = Number(response.headers.get("retry-after") || 0);
    await new Promise((resolve) => setTimeout(resolve, Math.max(retryAfter * 1000, 1000 * (2 ** attempt))));
  }
  throw new Error(`${operation} failed after retries`);
}
const metadataResponse = await fetch(
  `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties(title,gridProperties(rowCount,columnCount))`,
  { headers: sheetsHeaders });
if (!metadataResponse.ok) await googleFailure(metadataResponse, "Sheets metadata");
const metadata = await metadataResponse.json();
const sheetRows = new Map((metadata.sheets || []).map((sheet) => [
  sheet.properties.title, Number(sheet.properties.gridProperties?.rowCount || 0),
]));

function columnLetter(columns) {
  let value = columns, result = "";
  while (value > 0) { value--; result = String.fromCharCode(65 + (value % 26)) + result; value = Math.floor(value / 26); }
  return result;
}
async function exportSheet(sheet, startRow, columns, ceiling) {
  const lastRow = Math.min(sheetRows.get(sheet) || 0, ceiling);
  if (lastRow < startRow) throw new Error(`source sheet missing or empty: ${sheet}`);
  const rows = [];
  const chunkRows = Math.max(1, Math.floor(100000 / columns));
  for (let row = startRow; row <= lastRow; row += chunkRows) {
    const end = Math.min(lastRow, row + chunkRows - 1);
    const a1 = `${sheet}!A${row}:${columnLetter(columns)}${end}`;
    const response = await sheetsFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(a1)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`,
      `Sheets read ${sheet}`);
    rows.push(...((await response.json()).values || []));
  }
  return rows.filter((row) => String(row?.[0] || "").trim());
}

const [problemRows, gradingRows] = await Promise.all([
  exportSheet("문제원장", 5, 35, 20004),
  exportSheet("채점키_비공개", 5, 7, 20004),
]);

function uniqueMap(rows, label) {
  const map = new Map();
  const duplicates = [];
  for (const row of rows) {
    const stableKey = String(row[0]);
    if (map.has(stableKey)) duplicates.push(stableKey);
    else map.set(stableKey, row);
  }
  if (duplicates.length) throw new Error(`${label} duplicate stable keys: ${duplicates.length}`);
  return map;
}

const problemByKey = uniqueMap(problemRows, "problem source");
const gradingByKey = uniqueMap(gradingRows, "grading source");
if (problemByKey.size !== EXPECTED || gradingByKey.size !== EXPECTED) {
  throw new Error(`source count mismatch: problems=${problemByKey.size}, grading=${gradingByKey.size}, expected=${EXPECTED}`);
}

const db = new pg.Client(postgresConnectionOptions(required(env.DATABASE_URL, "DATABASE_URL")));
await db.connect();

function gradingAad(stableKey, keyVersion) {
  return Buffer.from(JSON.stringify({ subjectId: SUBJECT, stableKey, keyVersion, encryptionKeyId: keyId }), "utf8");
}
function encryptJson(value, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}
function decryptJson(value, aad) {
  const bytes = Buffer.from(value);
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, bytes.subarray(0, 12));
  decipher.setAAD(aad);
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"));
}

try {
  const current = await db.query(
    "SELECT stable_key, source_version FROM problems WHERE subject_id=$1 ORDER BY stable_key", [SUBJECT]);
  if (current.rowCount !== EXPECTED) throw new Error(`database problem count mismatch: ${current.rowCount}`);

  const missingProblems = [], missingKeys = [], sourceMismatches = [], keyVersionMismatches = [], prepared = [];
  for (const row of current.rows) {
    const source = problemByKey.get(row.stable_key);
    const grading = gradingByKey.get(row.stable_key);
    if (!source) missingProblems.push(row.stable_key);
    if (!grading) missingKeys.push(row.stable_key);
    if (source && String(source[9] || "unknown") !== String(row.source_version)) sourceMismatches.push(row.stable_key);
    if (source && grading) {
      const sourceVersion = String(source[9] || "").trim();
      const keyVersion = String(grading[5] || "").trim();
      if (!sourceVersion || !keyVersion || keyVersion !== sourceVersion) {
        keyVersionMismatches.push(row.stable_key);
        continue;
      }
      const payload = { answer: grading[1], rationale: grading[2], rubric: grading[3], source: grading[4], status: grading[6] };
      const payloadText = JSON.stringify(payload);
      const aad = gradingAad(row.stable_key, keyVersion);
      const encrypted = encryptJson(payload, aad);
      if (JSON.stringify(decryptJson(encrypted, aad)) !== payloadText) throw new Error("AES-GCM round-trip failed");
      prepared.push({
        stableKey: row.stable_key,
        keyVersion,
        encrypted,
        digest: sha(payloadText),
      });
    }
  }
  if (missingProblems.length || missingKeys.length || sourceMismatches.length || keyVersionMismatches.length || prepared.length !== EXPECTED) {
    throw new Error(`validation failed: missingProblems=${missingProblems.length}, missingKeys=${missingKeys.length}, sourceMismatches=${sourceMismatches.length}, keyVersionMismatches=${keyVersionMismatches.length}, prepared=${prepared.length}`);
  }

  const migration = await readFile(new URL("./migrations/0002_grading_key_rotation.sql", import.meta.url), "utf8");
  await db.query(migration);
  await db.query("BEGIN");
  await db.query("SELECT pg_advisory_xact_lock(hashtext('civil-grading-key-rotation'))");
  const prior = await db.query(
    `SELECT stable_key, key_version, encrypted_payload, payload_digest, verification_state, active_for_grading
       FROM private_grading_keys
      WHERE subject_id=$1 AND encryption_key_id=$2`, [SUBJECT, keyId]);
  if (prior.rowCount) {
    if (prior.rowCount !== EXPECTED) throw new Error(`partial key generation exists: ${prior.rowCount}`);
    const preparedByKey = new Map(prepared.map((item) => [item.stableKey, item]));
    for (const row of prior.rows) {
      const expected = preparedByKey.get(row.stable_key);
      if (!expected || expected.digest !== row.payload_digest || expected.keyVersion !== row.key_version) {
        throw new Error("existing key generation differs from source");
      }
      if (row.verification_state !== "verified" || row.active_for_grading !== true) {
        throw new Error("existing key generation is not verified and active");
      }
      decryptJson(row.encrypted_payload, gradingAad(row.stable_key, row.key_version));
    }
    await db.query("ROLLBACK");
    return { ok: true, replayed: true, verified: prior.rowCount, keyId };
  } else {
    await db.query("UPDATE private_grading_keys SET active_for_grading=false WHERE subject_id=$1", [SUBJECT]);
    const chunkSize = 100;
    for (let offset = 0; offset < prepared.length; offset += chunkSize) {
      const chunk = prepared.slice(offset, offset + chunkSize), values = [];
      const tuples = chunk.map((item) => {
        const base = values.length;
        values.push(SUBJECT, item.stableKey, item.keyVersion, item.encrypted, item.digest, keyId);
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},'verified',true,now())`;
      }).join(",");
      await db.query(`INSERT INTO private_grading_keys
        (subject_id,stable_key,key_version,encrypted_payload,payload_digest,encryption_key_id,
         verification_state,active_for_grading,verified_at) VALUES ${tuples}`, values);
    }
    const verified = await db.query(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE active_for_grading AND verification_state='verified')::int AS active
         FROM private_grading_keys WHERE subject_id=$1 AND encryption_key_id=$2`, [SUBJECT, keyId]);
    if (verified.rows[0].total !== EXPECTED || verified.rows[0].active !== EXPECTED) throw new Error("post-insert verification failed");
    await db.query(`INSERT INTO audit_events(actor_id,subject_id,action,aggregate_type,aggregate_id,payload_digest,metadata)
      VALUES('maintenance:grading-key-rotation',$1,'REENCRYPT','grading_key_generation',$2,$3,$4)`,
      [SUBJECT, keyId, sha(prepared.map((item) => `${item.stableKey}:${item.digest}`).join("\n")),
       JSON.stringify({ verified: EXPECTED, previousRowsPreserved: true })]);
    await db.query("COMMIT");
    return { ok: true, replayed: false, verified: EXPECTED, activated: EXPECTED, keyId };
  }
} catch (error) {
  await db.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  await db.end();
}
} finally {
  encryptionKey.fill(0);
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(await reencryptGradingKeys()));
}
