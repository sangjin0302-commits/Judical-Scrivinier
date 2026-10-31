import pg from "pg";
import { postgresConnectionOptions } from "./pg-connection.mjs";

const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error("database URL is unavailable");
const client = new pg.Client(postgresConnectionOptions(connectionString));

const snapshot = async () => (await client.query(
  `SELECT archived_count::bigint::text, failed_count::bigint::text,
          last_archived_wal, last_archived_time, last_failed_wal, last_failed_time
     FROM pg_stat_archiver`,
)).rows[0];

await client.connect();
try {
  const before = await snapshot();
  await client.query("SELECT pg_switch_wal()");
  let after = before;
  for (let attempt = 0; attempt < 12; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    after = await snapshot();
    if (BigInt(after.archived_count) > BigInt(before.archived_count)) break;
  }
  const archivedAdvanced = BigInt(after.archived_count) > BigInt(before.archived_count);
  const failuresUnchanged = BigInt(after.failed_count) === BigInt(before.failed_count);
  if (!archivedAdvanced || !failuresUnchanged) throw new Error("PITR WAL archive verification failed");
  process.stdout.write(JSON.stringify({
    ok: true,
    archivedAdvanced,
    failuresUnchanged,
    before: { archivedCount: before.archived_count, failedCount: before.failed_count,
      lastArchivedWal: before.last_archived_wal, lastArchivedTime: before.last_archived_time },
    after: { archivedCount: after.archived_count, failedCount: after.failed_count,
      lastArchivedWal: after.last_archived_wal, lastArchivedTime: after.last_archived_time },
  }));
} finally {
  await client.end();
}
