import assert from "node:assert/strict";
import test from "node:test";

import { aggregateDocsProblems } from "../db/verify-docs-aggregates-readonly.mjs";

test("Docs aggregate verifier uses read-only transaction and returns hashes without source text", async () => {
  const calls = [];
  const client = { async query(sql) {
    calls.push(sql);
    if (sql.startsWith("SELECT stable_key")) {
      return { rows: [{ stable_key: "SRC-CIV-004|sample", prompt_text: "private source prompt" }] };
    }
    return { rows: [] };
  } };
  const result = await aggregateDocsProblems(client);
  assert.equal(calls[0], "BEGIN READ ONLY");
  assert.equal(calls.at(-1), "COMMIT");
  assert.equal(result.readOnly, true);
  assert.equal(result.sources.length, 3);
  assert.match(result.sources[0].keyDigest, /^[0-9a-f]{64}$/);
  assert.match(result.sources[0].promptDigest, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /private source prompt|SRC-CIV-004\|sample/);
});
