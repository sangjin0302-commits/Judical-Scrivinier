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

test("read-only folder diagnostic still requires maintenance authentication", async () => {
  const response = await POST(new Request("https://example.test/api/maintenance/sync-drive-folder-documents?dryRun=true", {
    method: "POST",
  }));
  assert.equal(response.status, 401);
});

test("invalid dryRun cannot silently fall through to mutating sync", async () => {
  const previous = process.env.MAINTENANCE_TOKEN;
  const token = "test-only-maintenance-token-32-characters";
  process.env.MAINTENANCE_TOKEN = token;
  try {
    const response = await POST(new Request("https://example.test/api/maintenance/sync-drive-folder-documents?dryRun=1", {
      method: "POST", headers: { "x-maintenance-token": token },
    }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: "invalid dryRun option" });
  } finally {
    if (previous === undefined) delete process.env.MAINTENANCE_TOKEN;
    else process.env.MAINTENANCE_TOKEN = previous;
  }
});
