import assert from "node:assert/strict";
import test from "node:test";

import { detectAllGoogleDocs } from "../db/detect-google-docs-sync.mjs";
import { POST } from "../app/api/maintenance/detect-google-docs-sync/route.js";

test("maintenance detection fetches approved Docs and returns identifiers only", async () => {
  const calls = [];
  let ended = false;
  class Pool {
    constructor() {}
    async end() { ended = true; }
  }
  const env = { GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_REFRESH_TOKEN: "refresh", DATABASE_URL: "postgres://test:test@localhost:55432/test" };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === "https://oauth2.googleapis.com/token") {
      return { ok: true, async json() { return { access_token: "access-secret" }; } };
    }
    return { ok: true, async json() { return {
      documentId: "doc-1", revisionId: "r1", title: "Synthetic document", body: { content: [] },
    }; } };
  };
  const detect = async (_pool, snapshot, actor) => {
    assert.equal(actor, "maintenance:google-docs");
    assert.equal(snapshot.documentId, "doc-1");
    assert.match(snapshot.requestId, /^docs-detect:[a-f0-9]{64}$/);
    return { syncRunId: "run-1", replayed: false,
      counts: { NEW: 1, MODIFIED: 0, UNCHANGED: 0, DUPLICATE: 0, DELETE_CANDIDATE: 0 },
      candidates: [{ candidate_id: "c-1", candidate_kind: "NEW", stable_key: "private-key",
        candidate_payload: { promptText: "private question", answerDigest: "private digest" } },
      { candidate_id: "c-2", candidate_kind: "UNCHANGED", stable_key: "private-key-2" }] };
  };
  const result = await detectAllGoogleDocs({ env, fetchImpl, Pool, detect,
    sources: [["SRC-CIV-004", "doc-1"]] });
  assert.deepEqual(result.sources[0].candidates, [{ candidateId: "c-1", kind: "NEW" }]);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(result.applied, false);
  assert.equal(calls[1].init.method, "GET");
  assert.equal(calls[1].url.includes("access-secret"), false);
  assert.equal(ended, true);
});

test("maintenance detection refuses missing token without fetching or writing", async () => {
  const response = await POST(new Request("http://localhost/api/maintenance/detect-google-docs-sync",
    { method: "POST" }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, error: "unauthorized" });
});
