import pg from "pg";
import { postgresConnectionOptions } from "./pg-connection.mjs";

async function main() {
  const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL required");
  const pool = new pg.Pool(postgresConnectionOptions(connectionString, { max: 1 }));
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const metadata = await client.query(`SELECT stage::text AS stage,field,count(*)::int AS rows
      FROM problems CROSS JOIN LATERAL jsonb_object_keys(selection_metadata) AS field
      WHERE subject_id='CIVIL' GROUP BY stage,field ORDER BY stage,rows DESC,field`);
    const events = await client.query(`SELECT event_type,count(*)::int AS rows FROM learning_events
      WHERE subject_id='CIVIL' GROUP BY event_type ORDER BY rows DESC,event_type`);
    const eventFields = await client.query(`SELECT event_type,field,count(*)::int AS rows
      FROM learning_events CROSS JOIN LATERAL jsonb_object_keys(payload) AS field
      WHERE subject_id='CIVIL' AND event_type<>'CONCEPT_RECALL'
      GROUP BY event_type,field ORDER BY event_type,rows DESC,field`);
    const history = await client.query(`SELECT
      (SELECT count(*)::int FROM p1_grades WHERE subject_id='CIVIL') AS p1_grades,
      (SELECT count(*)::int FROM p2_grades WHERE subject_id='CIVIL') AS p2_grades,
      (SELECT count(*)::int FROM issue_sets WHERE subject_id='CIVIL') AS issue_sets`);
    const keyFormats = await client.query(`WITH sampled AS (
      SELECT stage::text AS stage,stable_key,
        selection_metadata->>'originalId' AS original_id,
        selection_metadata->>'type' AS type,
        selection_metadata->>'detailType' AS detail_type,
        row_number() OVER (PARTITION BY stage ORDER BY source_order) AS row_number
      FROM problems WHERE subject_id='CIVIL' AND published=true)
      SELECT stage,stable_key,original_id,type,detail_type FROM sampled
      WHERE row_number<=3 ORDER BY stage,row_number`);
    await client.query("COMMIT");
    return { readOnly: true, metadata: metadata.rows, events: events.rows,
      eventFields: eventFields.rows,
      history: history.rows[0], keyFormats: keyFormats.rows };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

try { process.stdout.write(JSON.stringify(await main()) + "\n"); }
catch (error) {
  process.stderr.write(JSON.stringify({ ok: false, code: error.code || error.name }) + "\n");
  process.exitCode = 1;
}
