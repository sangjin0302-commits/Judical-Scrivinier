import assert from "node:assert/strict";
import test from "node:test";

import { postgresConnectionOptions, postgresSslOptions } from "../db/pg-connection.mjs";

const url = (hostname) => `postgresql://user:placeholder@${hostname}:5432/database`;

test("Railway public TCP proxy allows encrypted connection with platform certificate", () => {
  assert.deepEqual(postgresSslOptions(url("switchback.proxy.rlwy.net")), { rejectUnauthorized: false });
  assert.deepEqual(postgresSslOptions(url("regional.proxy.rlwy.net")), { rejectUnauthorized: false });
});

test("Railway private network disables TLS only for railway.internal suffix", () => {
  assert.equal(postgresSslOptions(url("postgres.railway.internal")), false);
});

test("lookalike and unrelated hosts always keep strict certificate validation", () => {
  for (const hostname of [
    "switchback.proxy.rlwy.net.example.com",
    "evilproxy.rlwy.net",
    "railway.internal.example.com",
    "evilrailway.internal",
    "db.example.com",
  ]) {
    assert.deepEqual(postgresSslOptions(url(hostname)), { rejectUnauthorized: true });
  }
});

test("connection helper preserves safe pool options without exposing credentials", () => {
  const connectionString = url("switchback.proxy.rlwy.net");
  assert.deepEqual(postgresConnectionOptions(connectionString, { max: 2 }), {
    connectionString,
    max: 2,
    ssl: { rejectUnauthorized: false },
  });
  assert.throws(() => postgresSslOptions("not-a-url"), /valid PostgreSQL URL/);
});
