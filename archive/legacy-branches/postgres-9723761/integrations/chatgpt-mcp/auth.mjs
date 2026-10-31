import { createRemoteJWKSet, jwtVerify } from "jose";

function requiredEnv(name, env = process.env) {
  const value = String(env[name] || "").trim();
  if (!value) throw new Error(`필수 환경변수 누락: ${name}`);
  return value;
}

function normalizedUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

export function authConfig(env = process.env) {
  const issuer = normalizedUrl(requiredEnv("WORKOS_AUTHKIT_DOMAIN", env));
  const resource = normalizedUrl(requiredEnv("MCP_RESOURCE_URL", env));
  const allowedUsers = new Set(
    requiredEnv("ALLOWED_WORKOS_USER_IDS", env)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const requiredScopes = String(env.WORKOS_REQUIRED_SCOPES || "openid")
    .split(/[ ,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  return { issuer, resource, allowedUsers, requiredScopes };
}

function tokenScopes(payload) {
  if (Array.isArray(payload.scope)) return payload.scope.map(String);
  return String(payload.scope || "")
    .split(" ")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function createWorkOSVerifier(env = process.env) {
  let initialized;
  return async (_request, bearerToken) => {
    if (!bearerToken) return undefined;
    try {
      if (!initialized) {
        const config = authConfig(env);
        initialized = {
          config,
          jwks: createRemoteJWKSet(new URL(`${config.issuer}/oauth2/jwks`)),
        };
      }
      const { config, jwks } = initialized;
      const { payload } = await jwtVerify(bearerToken, jwks, {
        issuer: config.issuer,
        audience: config.resource,
        algorithms: ["RS256"],
      });
      const userId = String(payload.sub || "").trim();
      const scopes = tokenScopes(payload);
      if (!userId || !config.allowedUsers.has(userId)) return undefined;
      if (config.requiredScopes.some((scope) => !scopes.includes(scope))) return undefined;
      return {
        token: bearerToken,
        scopes,
        clientId: String(payload.client_id || payload.azp || "chatgpt"),
        extra: { userId },
      };
    } catch {
      return undefined;
    }
  };
}
