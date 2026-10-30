// Only SELECT over synthetic CTEs. No tables, rows or schema are created/changed.
import assert from "node:assert/strict";
import pg from "pg";
import { selectExamCandidates } from "../db/fast-exam-selection.mjs";

const target = new URL(process.env.TEST_DATABASE_URL || "http://invalid");
if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.port !== '55432' ||
    !/^exam_[a-z0-9_]+$/i.test(target.pathname.slice(1))) {
  throw new Error("requires disposable localhost:55432 exam_* database");
}
const db = new pg.Client({ connectionString: target.toString() });
const schemas = {
  problems: "subject_id text,stable_key text,stage text,published boolean,current_problem_version_id text,source_order bigint,prompt_text text,max_points numeric,source_version text,selection_metadata jsonb",
  private_grading_keys: "subject_id text,stable_key text,key_version text,encryption_key_id text,verification_state text,active_for_grading boolean,created_at timestamptz",
  issue_set_items: "set_id text,subject_id text,stable_key text,problem_version_id text",
  issue_sets: "set_id text,subject_id text,owner_id text,stage text,state text",
  submissions: "submission_id text,set_id text,subject_id text,owner_id text,state text,committed_at timestamptz,created_at timestamptz",
  original_answers: "submission_id text,subject_id text,stable_key text,answer_text text",
};
const prefix = Object.entries(schemas).map(([name, schema]) =>
  `${name} AS (SELECT * FROM jsonb_to_recordset($13::jsonb->'${name}') AS fixture(${schema}))`).join(',');

function fixture(stage, attempts) {
  const key = stage === 'P1' ? 'SYNTH|P1' : 'SYNTH|2025-제1회-문1-소문항1';
  const rows = Object.fromEntries(Object.keys(schemas).map(name => [name, []]));
  rows.problems.push({ subject_id: 'CIVIL', stable_key: key, stage, published: true,
    current_problem_version_id: 'v2', source_order: 1, prompt_text: 'synthetic',
    max_points: stage === 'P2' ? 10 : null, source_version: 'v2', selection_metadata: {} });
  rows.private_grading_keys.push({ subject_id: 'CIVIL', stable_key: key, key_version: 'key-v2',
    encryption_key_id: 'test-key', verification_state: 'verified', active_for_grading: true,
    created_at: '2026-01-01T00:00:00Z' });
  attempts.forEach((attempt, i) => {
    const set = `set-${i}`, sub = `sub-${i}`, owner = attempt.owner || 'owner';
    const date = `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`;
    rows.issue_set_items.push({ set_id: set, subject_id: 'CIVIL', stable_key: key,
      problem_version_id: attempt.version });
    rows.issue_sets.push({ set_id: set, subject_id: 'CIVIL', owner_id: owner,
      stage: attempt.stage || stage, state: attempt.active ? 'PREPARED' : 'COMMITTED' });
    rows.submissions.push({ submission_id: sub, set_id: set, subject_id: 'CIVIL', owner_id: owner,
      state: attempt.pending ? 'PREPARED' : 'COMMITTED', committed_at: date, created_at: date });
    if (attempt.original !== false) rows.original_answers.push({ submission_id: sub,
      subject_id: 'CIVIL', stable_key: key, answer_text: attempt.blank ? '   ' : 'synthetic answer' });
  });
  return rows;
}

let assertions = 0;
await db.connect();
try {
  await db.query('BEGIN READ ONLY');
  for (const stage of ['P1', 'P2']) {
    const cases = [
      { name: 'no attempts', attempts: [], selected: false },
      { name: 'v1 attempted and current v2', attempts: [{ version: 'v1' }], selected: true },
      { name: 'v2 attempted after v1 clears change', attempts: [{ version: 'v1' }, { version: 'v2' }], selected: false },
      { name: 'omitted v2 does not clear change', attempts: [{ version: 'v1' }, { version: 'v2', original: false }], selected: true },
      { name: 'blank v2 does not clear change', attempts: [{ version: 'v1' }, { version: 'v2', blank: true }], selected: true },
      { name: 'pending v2 does not clear change', attempts: [{ version: 'v1' }, { version: 'v2', pending: true }], selected: true },
      { name: 'other owner v2 does not clear change', attempts: [{ version: 'v1' }, { version: 'v2', owner: 'other' }], selected: true },
      { name: 'other stage v2 does not clear change', attempts: [{ version: 'v1' }, { version: 'v2', stage: stage === 'P1' ? 'P2' : 'P1' }], selected: true },
      { name: 'active v2 excludes allocation', attempts: [{ version: 'v1' }, { version: 'v2', pending: true, active: true }], selected: false },
    ];
    for (const scenario of cases) {
      const rows = fixture(stage, scenario.attempts);
      const client = { query(sql, params) {
        assert.match(sql, /^WITH /);
        return db.query(`WITH ${prefix},${sql.slice(5)}`, [...params, JSON.stringify(rows)]);
      } };
      const operation = selectExamCandidates(client, { stage, ownerId: 'owner', requestId: 'probe',
        keyId: 'test-key', mode: '원문변경', count: 1, caseCount: 1 });
      if (scenario.selected) assert.equal((await operation).length, 1, `${stage}: ${scenario.name}`);
      else await assert.rejects(operation, /not enough eligible/, `${stage}: ${scenario.name}`);
      assertions++;
    }
  }
  await db.query('ROLLBACK');
  process.stdout.write(JSON.stringify({ ok: true, assertions, syntheticCteOnly: true, transactionReadOnly: true }) + '\n');
} finally {
  await db.end();
}
