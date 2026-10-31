import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

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

test("desktop OAuth consent uses PKCE and permits existing client ID without a local secret", async () => {
  const source = await readFile(new URL("../oauth-login.mjs", import.meta.url), "utf8");
  assert.match(source, /code_challenge_method: "S256"/);
  assert.match(source, /code_verifier: codeVerifier/);
  assert.match(source, /oauthClient\.client_secret \? \{ client_secret:/);
  assert.match(source, /documents\.readonly/);
  assert.doesNotMatch(source, /console\.log\(token\)/);
});
