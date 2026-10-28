import assert from "node:assert/strict";
import test from "node:test";

import { authConfig } from "../auth.mjs";

test("auth config requires a bounded resource and explicit user allowlist", () => {
  const config = authConfig({
    WORKOS_AUTHKIT_DOMAIN: "https://civil-test.authkit.app/",
    MCP_RESOURCE_URL: "https://civil-test.vercel.app/mcp/",
    ALLOWED_WORKOS_USER_IDS: "user_1, user_2",
    WORKOS_REQUIRED_SCOPES: "openid civil:study",
  });
  assert.equal(config.issuer, "https://civil-test.authkit.app");
  assert.equal(config.resource, "https://civil-test.vercel.app/mcp");
  assert.deepEqual([...config.allowedUsers], ["user_1", "user_2"]);
  assert.deepEqual(config.requiredScopes, ["openid", "civil:study"]);
});

test("auth config rejects a missing allowlist", () => {
  assert.throws(
    () =>
      authConfig({
        WORKOS_AUTHKIT_DOMAIN: "https://civil-test.authkit.app",
        MCP_RESOURCE_URL: "https://civil-test.vercel.app/mcp",
      }),
    /ALLOWED_WORKOS_USER_IDS/,
  );
});
