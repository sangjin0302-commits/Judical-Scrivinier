// Read-only selection and DB latency inventory against existing independent test Railway DB.
import pg from "pg";
import { postgresConnectionOptions } from "./pg-connection.mjs";
import { selectExamCandidates } from "./fast-exam-selection.mjs";
import { benchmarkExamSelection } from "./selection-benchmark.mjs";

export async function verifyExamSelectionReadOnly({ env = process.env, Pool = pg.Pool } = {}) {
  const connectionString = env.DATABASE_PUBLIC_URL || env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const pool = new Pool(postgresConnectionOptions(connectionString, { max: 1 }));
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const key = await client.query(`SELECT encryption_key_id FROM private_grading_keys
      WHERE subject_id='CIVIL' AND verification_state='verified' AND active_for_grading=true
      GROUP BY encryption_key_id ORDER BY count(*) DESC LIMIT 1`);
    if (key.rowCount !== 1) throw new Error("verified grading key generation unavailable");
    const base = { ownerId: "readonly-selection-probe", keyId: key.rows[0].encryption_key_id,
      mode: "전범위" };
    const p1 = await selectExamCandidates(client, { ...base, stage: "P1", requestId: "probe-p1" });
    const p2 = await selectExamCandidates(client, { ...base, stage: "P2", requestId: "probe-p2" });
    const p1Exact = await selectExamCandidates(client, { ...base, stage: "P1", mode: "문제지정",
      requestId: "probe-p1-exact", specificKeys: [p1[0].stable_key] });
    const p2Exact = await selectExamCandidates(client, { ...base, stage: "P2", mode: "문제지정",
      requestId: "probe-p2-exact", specificKeys: [p2[0].stable_key] });
    const p1Type = await selectExamCandidates(client, { ...base, stage: "P1", count: 1,
      questionType: "1차 OX", requestId: "probe-p1-type" });
    const p2Type = await selectExamCandidates(client, { ...base, stage: "P2", caseCount: 1,
      questionType: "2차 서술형", requestId: "probe-p2-type" });
    const p2Number = await selectExamCandidates(client, { ...base, stage: "P2", caseCount: 1,
      year: "2025", session: "31", questionNumber: "1", requestId: "probe-p2-number" });
    const p1Unattempted = await selectExamCandidates(client, { ...base, stage: "P1",
      mode: "미풀이", count: 1, requestId: "probe-p1-unattempted" });
    const p1Timing = await benchmarkExamSelection(client, Array.from({ length: 12 }, (_, i) =>
      ({ ...base, stage: "P1", requestId: `probe-p1-bench-${i}` })));
    const p2Timing = await benchmarkExamSelection(client, Array.from({ length: 12 }, (_, i) =>
      ({ ...base, stage: "P2", requestId: `probe-p2-bench-${i}` })));
    await client.query("COMMIT");
    return { readOnly: true, p1DefaultItems: p1.length, p1ExactItems: p1Exact.length,
      p1TypeItems: p1Type.length, p2TypeItems: p2Type.length,
      p2NumberItems: p2Number.length, p1UnattemptedItems: p1Unattempted.length,
      p2DefaultItems: p2.length,
      p2DefaultGroups: new Set(p2.map((item) => item.group_key)).size,
      p2ExactItems: p2Exact.length, p1SelectionDbLatency: p1Timing,
      p2SelectionDbLatency: p2Timing };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("verify-exam-selection-readonly.mjs")) {
  try {
    process.stdout.write(JSON.stringify(await verifyExamSelectionReadOnly()) + "\n");
  } catch (error) {
    process.stderr.write(JSON.stringify({ ok: false, code: error.code || error.name }) + "\n");
    process.exitCode = 1;
  }
}
