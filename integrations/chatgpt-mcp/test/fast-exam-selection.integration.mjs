// Disposable localhost PostgreSQL only. Never point this script at Railway.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";

import { selectExamCandidates } from "../db/fast-exam-selection.mjs";
import { benchmarkExamSelection } from "../db/selection-benchmark.mjs";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL required");
const target = new URL(url);
if (!["127.0.0.1", "localhost"].includes(target.hostname) || target.port !== "55432" ||
    !/^exam_selection_[a-z0-9_]+$/i.test(target.pathname.slice(1))) {
  throw new Error("integration test requires disposable local exam_selection_* database on port 55432");
}
const pool = new pg.Pool({ connectionString: url, max: 1 });
const q = (sql, params) => pool.query(sql, params);
const migration = (name) => readFile(new URL(`../db/migrations/${name}`, import.meta.url), "utf8");
const p1Key = (n) => `SRC-CIV-004|SYNTH-P1-${n}`;
const group = (name) => `SRC-CIV-005|2025-제1회-문${name}`;
const p2Key = (name, sub) => `${group(name)}-소문항${sub}`;

try {
  const existing = await q("SELECT to_regclass('public.problems') AS problems");
  if (existing.rows[0].problems) throw new Error("disposable database must be empty");
  for (const name of ["0001_learning_ledger.sql", "0002_grading_key_rotation.sql"]) {
    await q(await migration(name));
  }
  await q("INSERT INTO subjects(subject_id,name) VALUES('CIVIL','Synthetic civil exam')");
  const addProblem = async (key, stage, order, { published = true, keyReady = true } = {}) => {
    await q(`INSERT INTO problems(subject_id,stable_key,stage,source_order,source_ref,source_version,
        prompt_text,max_points,published,content_digest)
      VALUES('CIVIL',$1,$2,$3,'synthetic','v1',$4,$5,$6,$7)`,
      [key, stage, order, `Synthetic ${stage} question ${order}`,
        stage === "P2" ? 15 : null, published, `digest-${order}`]);
    if (keyReady) await q(`INSERT INTO private_grading_keys(subject_id,stable_key,key_version,
        encrypted_payload,payload_digest,encryption_key_id,verification_state,active_for_grading)
      VALUES('CIVIL',$1,'v1',$2,'synthetic-digest','synthetic-key','verified',true)`,
      [key, Buffer.from("synthetic-ciphertext")]);
  };
  for (let n = 1; n <= 12; n++) await addProblem(p1Key(n), "P1", n, { keyReady: n !== 12 });
  for (let n = 1; n <= 2; n++) await addProblem(p2Key("1", n), "P2", 100 + n);
  for (let n = 1; n <= 2; n++) await addProblem(p2Key("2", n), "P2", 102 + n,
    { keyReady: n !== 2 });
  for (const name of ["0004_google_docs_sync.sql", "0008_exam_selection_indexes.sql",
    "0009_exam_review_due.sql"]) {
    await q(await migration(name));
  }

  const client = await pool.connect();
  try {
    const base = { ownerId: "synthetic-owner", keyId: "synthetic-key", mode: "전범위" };
    const p1 = await selectExamCandidates(client, { ...base, stage: "P1", requestId: "p1-default" });
    assert.equal(p1.length, 10);
    assert.equal(new Set(p1.map((row) => row.stable_key)).size, 10);
    assert.equal(p1.some((row) => row.stable_key === p1Key(12)), false);
    const exact = await selectExamCandidates(client, { ...base, stage: "P1", mode: "문제지정",
      specificKeys: [p1Key(2), p1Key(1)], requestId: "p1-exact" });
    assert.deepEqual(exact.map((row) => row.stable_key), [p1Key(2), p1Key(1)]);
    await assert.rejects(selectExamCandidates(client, { ...base, stage: "P1", mode: "문제지정",
      specificKeys: [p1Key(12)], requestId: "p1-missing-key" }), /missing or ineligible/);
    const p2 = await selectExamCandidates(client, { ...base, stage: "P2", requestId: "p2-default" });
    assert.deepEqual(p2.map((row) => row.stable_key), [p2Key("1", 1), p2Key("1", 2)]);
    const p2Exact = await selectExamCandidates(client, { ...base, stage: "P2", mode: "문제지정",
      specificKeys: [p2Key("1", 1)], requestId: "p2-exact" });
    assert.equal(p2Exact.length, 2);
    await assert.rejects(selectExamCandidates(client, { ...base, stage: "P2", mode: "문제지정",
      specificKeys: [group("2")], requestId: "p2-incomplete" }), /not enough eligible P2 cases/);
    await client.query(`INSERT INTO exam_review_due(owner_id,subject_id,stable_key,due_at)
      VALUES('synthetic-owner','CIVIL',$1,now() - interval '1 day')`, [p1Key(4)]);
    const due = await selectExamCandidates(client, { ...base, stage: "P1", count: 1,
      mode: "복습대상", requestId: "p1-due" });
    assert.deepEqual(due.map((row) => row.stable_key), [p1Key(4)]);
    await client.query(`INSERT INTO issue_sets(set_id,owner_id,subject_id,stage,request_id,request_digest)
      VALUES('SYNTH-ACTIVE','synthetic-owner','CIVIL','P1','active-1','synthetic-digest')`);
    await client.query(`INSERT INTO issue_set_items(set_id,subject_id,position,stable_key)
      VALUES('SYNTH-ACTIVE','CIVIL',1,$1)`, [p1Key(3)]);
    await assert.rejects(selectExamCandidates(client, { ...base, stage: "P1",
      mode: "문제지정", specificKeys: [p1Key(3)], requestId: "active-block" }), /missing or ineligible/);
    const latency = await benchmarkExamSelection(client,
      Array.from({ length: 12 }, (_, i) => ({ ...base, stage: "P1", requestId: `benchmark-${i}` })));
    assert.equal(latency.count, 12);
    process.stdout.write(JSON.stringify({ ok: true, p1Default: p1.length,
      p1Exact: exact.length, p2CaseItems: p2.length, incompleteCaseBlocked: true,
      dueAndActiveSetGuards: true,
      selectionDbLatency: latency }) + "\n");
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
