import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { authConfig, authEnvForRequest } from "../auth.mjs";

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

test("PR5 acceptance Preview derives only its registered WorkOS resource", () => {
  const preview = {
    WORKOS_AUTHKIT_DOMAIN: "https://civil-test.authkit.app",
    ALLOWED_WORKOS_USER_IDS: "user_1",
    VERCEL_ENV: "preview",
    VERCEL_GIT_COMMIT_REF: "integration/civil-exam-only",
    VERCEL_BRANCH_URL: "civil-p1-mcp-test-git-integ-e09f5d-sangjin0302-commits-projects.vercel.app",
  };
  assert.equal(
    authConfig(preview).resource,
    "https://civil-p1-mcp-test-git-integ-e09f5d-sangjin0302-commits-projects.vercel.app/mcp",
  );
  for (const change of [
    { VERCEL_ENV: "production" },
    { VERCEL_GIT_COMMIT_REF: "another-branch" },
    { VERCEL_BRANCH_URL: "another-preview.vercel.app" },
  ]) {
    assert.throws(() => authConfig({ ...preview, ...change }), /MCP_RESOURCE_URL/);
  }
});

test("PR5 request host supplies its resource without changing other hosts", () => {
  const env = {
    WORKOS_AUTHKIT_DOMAIN: "https://civil-test.authkit.app",
    ALLOWED_WORKOS_USER_IDS: "user_1",
  };
  const pr5 = "https://civil-p1-mcp-test-git-integ-e09f5d-sangjin0302-commits-projects.vercel.app/mcp";
  assert.equal(authConfig(authEnvForRequest(pr5, env)).resource, pr5);
  assert.throws(() => authConfig(authEnvForRequest("https://civil-p1-mcp-test.vercel.app/mcp", env)), /MCP_RESOURCE_URL/);
  assert.throws(() => authConfig(authEnvForRequest("http://civil-p1-mcp-test-git-integ-e09f5d-sangjin0302-commits-projects.vercel.app/mcp", env)), /MCP_RESOURCE_URL/);
  assert.equal(env.MCP_RESOURCE_URL, undefined);
});

test("desktop OAuth consent uses PKCE and permits existing client ID without a local secret", async () => {
  const source = await readFile(new URL("../oauth-login.mjs", import.meta.url), "utf8");
  assert.match(source, /code_challenge_method: "S256"/);
  assert.match(source, /code_verifier: codeVerifier/);
  assert.match(source, /oauthClient\.client_secret \? \{ client_secret:/);
  const { googleOAuthScopes } = await import("../oauth-profile.mjs");
  assert.ok(googleOAuthScopes().includes("https://www.googleapis.com/auth/documents.readonly"));
  assert.doesNotMatch(source, /console\.log\(token\)/);
});
