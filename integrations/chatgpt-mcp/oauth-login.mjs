import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const clientPath = resolve(process.env.GOOGLE_OAUTH_CLIENT_FILE || "private/oauth/google-desktop-client.json");
const tokenPath = resolve(process.env.GOOGLE_OAUTH_TOKEN_FILE || "private/oauth/google-user-token.json");
const envClient = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
  ? { client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET }
  : null;
const credentials = envClient ? null : JSON.parse(await readFile(clientPath, "utf8"));
const oauthClient = envClient || credentials.installed || credentials.web;
if (!oauthClient?.client_id || !oauthClient?.client_secret) throw new Error("OAuth 클라이언트 JSON 형식이 올바르지 않습니다.");

const state = randomBytes(24).toString("base64url");
const scopes = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/script.scriptapp",
  "https://www.googleapis.com/auth/documents.readonly"
];

const server = createServer(async (request, response) => {
  try {
    const callback = new URL(request.url, "http://127.0.0.1");
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
        client_secret: oauthClient.client_secret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri
      })
    });
    const token = await tokenResponse.json();
    if (!tokenResponse.ok || !token.refresh_token) throw new Error(`OAuth 토큰 발급 실패 (${tokenResponse.status})`);
    const grantedScopes = new Set(String(token.scope || "").split(/\s+/).filter(Boolean));
    if (scopes.some((scope) => !grantedScopes.has(scope))) {
      throw new Error("필요한 Google 읽기 권한이 모두 승인되지 않았습니다.");
    }
    await mkdir(dirname(tokenPath), { recursive: true });
    await writeFile(tokenPath, JSON.stringify({
      refresh_token: token.refresh_token,
      scope: token.scope,
      token_type: token.token_type
    }, null, 2), { mode: 0o600 });
    try { await chmod(tokenPath, 0o600); } catch {}
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("OAuth 승인이 완료되었습니다. 이 탭을 닫아도 됩니다.");
    process.stdout.write("OAUTH_COMPLETE\n");
  } catch (error) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("OAuth 승인을 완료하지 못했습니다.");
    process.stderr.write(`OAUTH_ERROR: ${error.message}\n`);
  } finally {
    server.close();
  }
});

server.listen(0, "127.0.0.1", () => {
  const redirectUri = `http://127.0.0.1:${server.address().port}/oauth2callback`;
  const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorization.search = new URLSearchParams({
    client_id: oauthClient.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state
  });
  process.stdout.write(`AUTH_URL=${authorization}\n`);
});

setTimeout(() => {
  process.stderr.write("OAUTH_ERROR: 승인 시간 초과\n");
  server.close();
}, 10 * 60 * 1000).unref();
