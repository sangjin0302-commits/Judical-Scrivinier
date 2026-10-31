function connectionHostname(connectionString) {
  try {
    const parsed = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname) throw new Error();
    return parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
}

export function postgresSslOptions(connectionString) {
  const hostname = connectionHostname(connectionString);
  if (hostname.endsWith(".railway.internal")) return false;
  if (hostname === "switchback.proxy.rlwy.net" || hostname.endsWith(".proxy.rlwy.net")) {
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true };
}

export function postgresConnectionOptions(connectionString, options = {}) {
  return { ...options, connectionString, ssl: postgresSslOptions(connectionString) };
}
