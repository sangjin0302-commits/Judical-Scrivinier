import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../app/api/maintenance/sync-drive-folder-documents/route.js";

test("folder sync route rejects requests without maintenance credential", async () => {
  const response = await POST(new Request("https://example.test/api/maintenance/sync-drive-folder-documents", {
    method: "POST",
  }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, error: "unauthorized" });
});
