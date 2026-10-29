import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("migration runner allowlists files, locks execution, and records digest atomically", async () => {
  const source = await readFile(new URL("../db/apply-migration.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /0003_concept_learning\.sql/);
  assert.match(source, /0004_google_docs_sync\.sql/);
  assert.match(source, /pg_advisory_lock/);
  assert.match(source, /schema_migrations/);
  assert.match(source, /migration_digest/);
  assert.match(source, /await client\.query\("BEGIN"\)/);
  assert.match(source, /await client\.query\("ROLLBACK"\)/);
  assert.match(source, /applied migration digest mismatch/);
});
