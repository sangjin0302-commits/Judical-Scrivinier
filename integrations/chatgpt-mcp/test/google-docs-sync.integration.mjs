// Run only against a disposable local PostgreSQL 18 instance. Never point at Railway.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { approveSyncCandidate, applyApprovedSyncCandidate, detectGoogleDocsChanges,
  sha256 } from '../db/google-docs-sync.mjs';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL required');
const target = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.port !== '55432') {
  throw new Error('integration test requires disposable local PostgreSQL on port 55432');
}
const pool = new pg.Pool({ connectionString: url, max: 2 });
const q = (sql, values) => pool.query(sql, values);
const migration = (name) => readFile(new URL(`../db/migrations/${name}`, import.meta.url), 'utf8');
const key = (suffix) => `SRC-CIV-004|SYNTH-${suffix}`;
const sourceId = 'SRC-CIV-004';
const documentId = 'synthetic-docs-sync-drill';
const actorId = 'synthetic-maintainer';

try {
  for (const name of ['0001_learning_ledger.sql', '0002_grading_key_rotation.sql',
    '0004_google_docs_sync.sql']) {
    if (name === '0004_google_docs_sync.sql') break;
    await q(await migration(name));
  }
  await q("INSERT INTO subjects(subject_id,name) VALUES('CIVIL','Synthetic civil')");
  await q(`INSERT INTO problems(subject_id,stable_key,stage,source_order,source_ref,source_version,
    prompt_text,published,content_digest) VALUES('CIVIL',$1,'P1',1,'synthetic-baseline','sheet-v1',$2,true,$3)`,
    [key('OLD'), 'Old synthetic question', sha256('Old synthetic question')]);
  await q(`INSERT INTO issue_sets(set_id,owner_id,subject_id,stage,request_id,request_digest,state)
    VALUES('SYNTH-SET','synthetic-owner','CIVIL','P1','synthetic-request',$1,'COMMITTED')`, ['0'.repeat(64)]);
  await q(`INSERT INTO issue_set_items(set_id,subject_id,position,stable_key)
    VALUES('SYNTH-SET','CIVIL',1,$1)`, [key('OLD')]);
  await q(await migration('0004_google_docs_sync.sql'));
  const before = await q(`SELECT problem_version_id FROM issue_set_items WHERE set_id='SYNTH-SET'`);
  const oldVersionId = before.rows[0].problem_version_id;
  assert.ok(oldVersionId);
  const problems = [
    { stableKey: key('OLD'), sourceLocator: 'old', sourceVersion: 'docs-v2-old', sourceOrder: 1,
      stage: 'P1', promptText: 'Revised synthetic question', maxPoints: null },
    { stableKey: key('NEW'), sourceLocator: 'new', sourceVersion: 'docs-v2-new', sourceOrder: 2,
      stage: 'P1', promptText: 'New synthetic question', maxPoints: null },
    { stableKey: key('CONFLICT'), sourceLocator: 'conflict', sourceVersion: 'docs-v2-conflict',
      sourceOrder: 1, stage: 'P1', promptText: 'Conflicting synthetic question', maxPoints: null },
  ];
  const detected = await detectGoogleDocsChanges(pool, { documentId, sourceId,
    title: 'Synthetic document', revisionId: 'r2', parserVersion: 'test-v1',
    contentDigest: sha256('synthetic document r2'), requestId: 'detect-r2', problems }, actorId);
  assert.equal(detected.counts.NEW, 2);
  assert.equal(detected.counts.MODIFIED, 1);
  const byKey = new Map(detected.candidates.map((item) => [item.stable_key, item]));
  for (const suffix of ['OLD', 'NEW', 'CONFLICT']) {
    await approveSyncCandidate(pool, { candidateId: byKey.get(key(suffix)).candidate_id,
      actorId, requestId: `approve-${suffix}`, approvalType: 'CONTENT', reason: 'Synthetic isolated test' });
  }
  for (const suffix of ['OLD', 'NEW']) {
    const id = byKey.get(key(suffix)).candidate_id;
    const applied = await applyApprovedSyncCandidate(pool, { candidateId: id, actorId });
    assert.equal(applied.replayed, false);
    const replay = await applyApprovedSyncCandidate(pool, { candidateId: id, actorId });
    assert.equal(replay.replayed, true);
  }
  await assert.rejects(() => applyApprovedSyncCandidate(pool,
    { candidateId: byKey.get(key('CONFLICT')).candidate_id, actorId }), /duplicate key/);
  const rows = await q(`SELECT stable_key,prompt_text,published,current_problem_version_id
    FROM problems WHERE subject_id='CIVIL' ORDER BY stable_key`);
  assert.equal(rows.rowCount, 2);
  assert.equal(rows.rows.find((row) => row.stable_key === key('OLD')).prompt_text,
    'Revised synthetic question');
  assert.equal(rows.rows.every((row) => row.published === false), true);
  const history = await q(`SELECT problem_version_id FROM issue_set_items WHERE set_id='SYNTH-SET'`);
  assert.equal(history.rows[0].problem_version_id, oldVersionId);
  const versions = await q(`SELECT count(*)::int AS n FROM problem_versions WHERE stable_key=$1`, [key('OLD')]);
  assert.equal(versions.rows[0].n, 2);
  const failed = await q(`SELECT state FROM sync_candidates WHERE candidate_id=$1`,
    [byKey.get(key('CONFLICT')).candidate_id]);
  assert.equal(failed.rows[0].state, 'APPROVED');
  process.stdout.write(JSON.stringify({ ok: true, approvedNewUnpublished: true,
    approvedModifiedUnpublished: true, oldIssueSetVersionPreserved: true,
    failedCandidateRolledBack: true, idempotentReplay: true }) + '\n');
} finally {
  await pool.end();
}
