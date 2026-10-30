import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { googleOAuthScopes } from "../oauth-profile.mjs";

test("Drive readonly profile requests only existing Docs reading and Drive metadata reading", () => {
  assert.deepEqual(googleOAuthScopes("drive-readonly"),[
    "https://www.googleapis.com/auth/documents.readonly",
    "https://www.googleapis.com/auth/drive.metadata.readonly",
  ]);
  assert.equal(googleOAuthScopes().length,4);
  assert.throws(()=>googleOAuthScopes("typo"),/Unknown/);
});

test("minimal OAuth requires separate private outputs and protects existing token file", async () => {
  const source=await readFile(new URL("../oauth-login.mjs",import.meta.url),"utf8");
  assert.match(source,/GOOGLE_OAUTH_TOKEN_FILE \|\| !process.env.GOOGLE_OAUTH_AUTH_URL_FILE/);
  assert.match(source,/profile === "drive-readonly" \? \{ flag: "wx" \}/);
  assert.match(source,/include_granted_scopes: "true"/);
  assert.match(source,/AUTH_URL_READY/);
  assert.match(source,/writeHead\(303, \{ location: "\/oauth-complete"/);
  assert.match(source,/callback.pathname === "\/oauth-complete" && completed/);
  assert.match(source,/"referrer-policy": "no-referrer"/);
  assert.match(source,/if \(!completed\) server.close\(\)/);
});
