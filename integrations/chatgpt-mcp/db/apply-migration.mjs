import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { postgresConnectionOptions } from "./pg-connection.mjs";

const ALLOWED = new Set([
  "0003_concept_learning.sql",
  "0004_google_docs_sync.sql",
  "0005_concept_sheet_questions.sql",
]);

function migrationBody(source) {
  return String(source)
    .replace(/^\s*BEGIN\s*;\s*/i, "")
    .replace(/\s*COMMIT\s*;\s*$/i, "")
    .trim();
}

export async function applyMigration(client, migrationPath) {
  const name = basename(migrationPath);
  if (!ALLOWED.has(name)) throw new Error(`migration not allowed: ${name}`);
  const source = await readFile(migrationPath, "utf8");
  const body = migrationBody(source);
  const digest = crypto.createHash("sha256").update(source).digest("hex");

  await client.query("SELECT pg_advisory_lock(hashtext($1))", ["civil-mcp-schema-migration"]);
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_name text PRIMARY KEY,
      migration_digest text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const prior = await client.query(
      "SELECT migration_digest FROM schema_migrations WHERE migration_name=$1",
      [name],
    );
    if (prior.rowCount) {
      if (prior.rows[0].migration_digest !== digest) {
        throw new Error(`applied migration digest mismatch: ${name}`);
      }
      return { migration: name, replayed: true };
    }

    await client.query("BEGIN");
    try {
      await client.query(body);
      await client.query(
        "INSERT INTO schema_migrations(migration_name,migration_digest) VALUES($1,$2)",
        [name, digest],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    return { migration: name, replayed: false };
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", ["civil-mcp-schema-migration"]);
  }
}

async function main() {
  const requested = process.argv[2];
  if (!requested) throw new Error("migration filename is required");
  const name = basename(requested);
  if (!ALLOWED.has(name)) throw new Error(`migration not allowed: ${name}`);
  // CLI runs outside Railway private DNS; prefer the encrypted public proxy when present.
  const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const migrationPath = resolve(fileURLToPath(new URL("./migrations/", import.meta.url)), name);
  const pool = new pg.Pool(postgresConnectionOptions(connectionString, { max: 1 }));
  const client = await pool.connect();
  try {
    process.stdout.write(JSON.stringify(await applyMigration(client, migrationPath)));
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
