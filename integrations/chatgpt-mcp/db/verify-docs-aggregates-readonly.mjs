import crypto from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { postgresConnectionOptions } from "./pg-connection.mjs";
import { normalizedPrompt } from "./google-docs-parser.mjs";

const SOURCES = ["SRC-CIV-004", "SRC-CIV-004B", "SRC-CIV-005"];
const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");

export async function aggregateDocsProblems(client) {
  await client.query("BEGIN READ ONLY");
  try {
    const result = [];
    for (const sourceId of SOURCES) {
      const query = await client.query(
        `SELECT stable_key,prompt_text FROM problems
          WHERE subject_id='CIVIL' AND stable_key LIKE $1 ORDER BY stable_key`,
        [`${sourceId}|%`],
      );
      const rows = query.rows;
      result.push({
        sourceId,
        count: rows.length,
        keyDigest: sha(rows.map((row) => row.stable_key).join("\n")),
        promptDigest: sha(rows.map((row) => `${row.stable_key}:${sha(row.prompt_text)}`).join("\n")),
      });
    }
    await client.query("COMMIT");
    return { readOnly: true, sources: result };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  const pageArg = process.argv.find((arg) => arg.startsWith("--manifest-page="));
  const manifestPage = pageArg === undefined ? null : Number(pageArg.split("=")[1]);
  if (manifestPage !== null && (!Number.isInteger(manifestPage) || manifestPage < 0 || manifestPage > 100)) {
    throw new Error("Invalid manifest page");
  }
  const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool(postgresConnectionOptions(connectionString, { max: 1 }));
  const client = await pool.connect();
  try {
    if (manifestPage !== null) {
      await client.query("BEGIN READ ONLY");
      const query = await client.query(
        `SELECT stable_key,prompt_text FROM problems
          WHERE subject_id='CIVIL' AND (stable_key LIKE 'SRC-CIV-004|%' OR stable_key LIKE 'SRC-CIV-004B|%' OR stable_key LIKE 'SRC-CIV-005|%')
          ORDER BY stable_key LIMIT 512 OFFSET $1`,
        [manifestPage * 512],
      );
      const manifest = query.rows.map((row) => [
        sha(row.stable_key),
        sha(row.prompt_text),
        sha(normalizedPrompt(row.prompt_text)),
      ]);
      await client.query("COMMIT");
      process.stdout.write(JSON.stringify(manifest));
    } else {
      process.stdout.write(JSON.stringify(await aggregateDocsProblems(client)));
    }
  }
  finally { client.release(); await pool.end(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
