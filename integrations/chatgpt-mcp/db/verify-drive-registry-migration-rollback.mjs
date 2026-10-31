import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { postgresConnectionOptions } from "./pg-connection.mjs";

const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const path = fileURLToPath(new URL("./migrations/0010_drive_document_registry.sql", import.meta.url));
const body = (await readFile(path, "utf8"))
  .replace(/^\s*BEGIN\s*;\s*/i, "")
  .replace(/\s*COMMIT\s*;\s*$/i, "");
const pool = new pg.Pool(postgresConnectionOptions(connectionString, { max: 1 }));
const client = await pool.connect();
let started = false;
let result;
try {
  const before = await client.query("SELECT to_regclass('public.document_registry') IS NOT NULL AS present");
  if (before.rows[0].present) throw new Error("registry migration already applied; rollback probe requires pre-migration DB");
  await client.query("BEGIN");
  started = true;
  await client.query("SET LOCAL statement_timeout = '15s'");
  await client.query(body);
  const folders = await client.query("SELECT count(*)::integer AS n FROM document_folders");
  const legacy = await client.query("SELECT count(*)::integer AS n FROM document_registry WHERE registration_kind='EXTERNAL'");
  const stable = await client.query("SELECT count(*)::integer AS n FROM problems WHERE subject_id='CIVIL'");
  result = { migrationRollbackTest: "passed",
    folders: folders.rows[0].n, legacySources: legacy.rows[0].n,
    civilProblemsUnchangedWithinTransaction: stable.rows[0].n };
} finally {
  try {
    if (started) {
      await client.query("ROLLBACK");
      const after = await client.query("SELECT to_regclass('public.document_registry') IS NOT NULL AS present");
      if (after.rows[0].present) throw new Error("registry table persisted after rollback");
    }
  } finally {
    client.release();
    await pool.end();
  }
}
process.stdout.write(JSON.stringify(result) + "\n");
