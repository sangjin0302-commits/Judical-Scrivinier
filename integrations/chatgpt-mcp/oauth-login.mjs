import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { googleOAuthScopes } from "./oauth-profile.mjs";

const profile = process.argv.find((arg) => arg.startsWith("--profile="))?.slice("--profile=".length) || "legacy";
const scopes = googleOAuthScopes(profile);
if (profile === "drive-readonly" && (!process.env.GOOGLE_OAUTH_TOKEN_FILE || !process.env.GOOGLE_OAUTH_AUTH_URL_FILE)) {
  throw new Error("Read-only OAuth requires explicit private candidate token and authorization URL files");
}

const clientPath = resolve(process.env.GOOGLE_OAUTH_CLIENT_FILE || "private/oauth/google-desktop-client.json");
const tokenPath = resolve(process.env.GOOGLE_OAUTH_TOKEN_FILE || "private/oauth/google-user-token.json");
const envClient = process.env.GOOGLE_CLIENT_ID
  ? { client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET }
  : null;
const credentials = envClient ? null : JSON.parse(await readFile(clientPath, "utf8"));
const oauthClient = envClient || credentials.installed || credentials.web;
if (!oauthClient?.client_id) throw new Error("OAuth 클라이언트 ID가 없습니다.");

const state = randomBytes(24).toString("base64url");
const codeVerifier = randomBytes(48).toString("base64url");
const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
let completed = false;

const server = createServer(async (request, response) => {
  try {
    const callback = new URL(request.url, "http://127.0.0.1");
    if (callback.pathname === "/oauth-complete" && completed) {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("OAuth 승인이 완료되었습니다. 이 탭을 닫아도 됩니다.");
      server.close();
      return;
    }
    if (callback.pathname !== "/oauth2callback") {
      response.writeHead(404).end("Not found");
      return;
    }
    if (callback.searchParams.get("state") !== state) throw new Error("OAuth state 불일치");
    const code = callback.searchParams.get("code");
    if (!code) throw new Error(callback.searchParams.get("error") || "OAuth code 누락");

    const redirectUri = `http://127.0.0.1:${server.address().port}/oauth2callback`;
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: oauthClient.client_id,
        ...(oauthClient.client_secret ? { client_secret: oauthClient.client_secret } : {}),
        code,
        code_verifier: codeVerifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri
      })
    });
    const token = await tokenResponse.json();
    if (!tokenResponse.ok || !token.refresh_token) {
      const errorCode = String(token.error || "missing_refresh_token").replace(/[^a-z_]/g, "");
      const detail = String(token.error_description || "");
      const cause = ["client_secret", "client_id", "code_verifier", "redirect_uri", "grant_type"]
        .find((field) => detail.includes(field)) || "other";
      throw new Error(`OAuth 토큰 발급 실패 (${tokenResponse.status}, ${errorCode}, ${cause})`);
    }
    const grantedScopes = new Set(String(token.scope || "").split(/\s+/).filter(Boolean));
    if (scopes.some((scope) => !grantedScopes.has(scope))) {
      throw new Error("필요한 Google 읽기 권한이 모두 승인되지 않았습니다.");
    }
    await mkdir(dirname(tokenPath), { recursive: true });
    await writeFile(tokenPath, JSON.stringify({
      refresh_token: token.refresh_token,
      scope: token.scope,
      token_type: token.token_type
    }, null, 2), { mode: 0o600, ...(profile === "drive-readonly" ? { flag: "wx" } : {}) });
    try { await chmod(tokenPath, 0o600); } catch {}
    completed = true;
    response.writeHead(303, { location: "/oauth-complete", "cache-control": "no-store", "referrer-policy": "no-referrer" });
    response.end();
    process.stdout.write("OAUTH_COMPLETE\n");
    // Permit the clean redirect target to load, but do not leave the listener up
    // indefinitely when the browser disconnects before following the redirect.
    setTimeout(() => server.close(), 10000).unref();
  } catch (error) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("OAuth 승인을 완료하지 못했습니다.");
    process.stderr.write(`OAUTH_ERROR: ${error.message}\n`);
  } finally {
    if (!completed) server.close();
  }
});

server.listen(0, "127.0.0.1", async () => {
  const redirectUri = `http://127.0.0.1:${server.address().port}/oauth2callback`;
  const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorization.search = new URLSearchParams({
    client_id: oauthClient.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    include_granted_scopes: "true",
    prompt: "consent",
    state
  });
  if (process.env.GOOGLE_OAUTH_AUTH_URL_FILE) {
    try {
      const authPath = resolve(process.env.GOOGLE_OAUTH_AUTH_URL_FILE);
      await mkdir(dirname(authPath), { recursive: true });
      await writeFile(authPath, String(authorization), { mode: 0o600, flag: "wx" });
      process.stdout.write("AUTH_URL_READY\n");
    } catch {
      process.stderr.write("OAUTH_ERROR: private authorization file unavailable\n");
      server.close();
    }
  } else process.stdout.write(`AUTH_URL=${authorization}\n`);
});

setTimeout(() => {
  process.stderr.write("OAUTH_ERROR: 승인 시간 초과\n");
  server.close();
}, 30 * 60 * 1000).unref();
