import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { parseP1Document, parseP2Document, digestText, normalizedPrompt } from "./google-docs-parser.mjs";
import { postgresConnectionOptions } from "./pg-connection.mjs";

const SOURCES = [
  { sourceId: "SRC-CIV-004", documentId: "169rzZ3qlM-LfZI7I6gCSwWEeJ4Cc8RiHZzH9Qm_dwys", parser: parseP1Document },
  { sourceId: "SRC-CIV-004B", documentId: "1hEQNsDti70lCSYG5PL90s7klhpqQJ-V4kERpSocuLLc", parser: parseP1Document },
  { sourceId: "SRC-CIV-005", documentId: "1xP0jLOUUQWzUGrv0whx7_z1cyVWAghxlGJVQo3Do_xA", parser: parseP2Document },
];

function required(value, name) {
  const result = String(value || "").trim();
  if (!result) throw new Error(name + " is required");
  return result;
}

async function accessToken(env) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: required(env.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID"),
      client_secret: required(env.GOOGLE_CLIENT_SECRET, "GOOGLE_CLIENT_SECRET"),
      refresh_token: required(env.GOOGLE_REFRESH_TOKEN, "GOOGLE_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) throw new Error("Google OAuth refresh failed");
  return payload.access_token;
}

async function fetchDocument(documentId, token) {
  const response = await fetch("https://docs.googleapis.com/v1/documents/" +
    encodeURIComponent(documentId) + "?includeTabsContent=true", {
    method: "GET",
    headers: { authorization: "Bearer " + token },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const reason = payload?.error?.status || payload?.error?.errors?.[0]?.reason || "unknown";
    throw new Error("Google Docs read failed: " + response.status + " " + reason);
  }
  const document = await response.json();
  if (document.documentId !== documentId) throw new Error("Google Docs document id mismatch");
  return document;
}

async function compareSource(client, source, parsed) {
  const rows = await client.query(
    "SELECT stable_key,prompt_text,content_digest FROM problems " +
      "WHERE subject_id='CIVIL' AND stable_key LIKE $1",
    [source.sourceId + "|%"],
  );
  const db = new Map(rows.rows.map((row) => [row.stable_key, row]));
  const docs = new Map(parsed.problems.map((problem) => [problem.stableKey, problem]));
  let exactPromptMatches = 0;
  let normalizedPromptMatches = 0;
  let promptMismatches = 0;
  for (const [stableKey, problem] of docs) {
    const row = db.get(stableKey);
    if (!row) continue;
    if (row.content_digest === problem.promptDigest || digestText(row.prompt_text) === problem.promptDigest) {
      exactPromptMatches += 1;
    } else if (digestText(normalizedPrompt(row.prompt_text)) ===
        digestText(normalizedPrompt(problem.promptText))) {
      normalizedPromptMatches += 1;
    } else {
      promptMismatches += 1;
    }
  }
  return {
    sourceId: source.sourceId,
    parsedOccurrences: parsed.occurrenceCount,
    parsedUnique: docs.size,
    duplicateOccurrences: parsed.duplicateOccurrences,
    conflictingDuplicateKeys: parsed.conflictingKeys.length,
    dbCount: db.size,
    missingInDb: [...docs.keys()].filter((key) => !db.has(key)).length,
    missingInDocs: [...db.keys()].filter((key) => !docs.has(key)).length,
    exactPromptMatches,
    normalizedPromptMatches,
    promptMismatches,
  };
}

export async function verifyGoogleDocsParity(env = process.env) {
  const token = await accessToken(env);
  const connectionString = required(env.DATABASE_PUBLIC_URL || env.DATABASE_URL, "DATABASE_URL");
  const pool = new pg.Pool(postgresConnectionOptions(connectionString, { max: 1 }));
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const results = [];
    for (const source of SOURCES) {
      const document = await fetchDocument(source.documentId, token);
      const parsed = source.parser(document, source.sourceId);
      results.push(await compareSource(client, source, parsed));
    }
    await client.query("COMMIT");
    return { ok: true, readOnly: true, sources: results };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.stdout.write(JSON.stringify(await verifyGoogleDocsParity()));
}
