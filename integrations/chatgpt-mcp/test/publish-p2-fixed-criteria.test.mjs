import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { publishP2FixedCriteria, p2PublicationDigest } from "../db/publish-p2-fixed-criteria.mjs";
import { createP2CriteriaManifest } from "../db/p2-fixed-criteria.mjs";
import { decryptGradingPayload, gradingAad } from "../db/postgres-adapter.mjs";

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function setup() {
  const encryptionKey = crypto.randomBytes(32), encryptionKeyId = 'synthetic-key';
  const source = { answer: 'A B', rubric: 'A B', source: 'synthetic' };
  const plain = JSON.stringify(source), iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  cipher.setAAD(gradingAad('CIVIL', 'synthetic-item', 'v1', encryptionKeyId));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const original = { encrypted_payload: Buffer.concat([iv, cipher.getAuthTag(), body]),
    payload_digest: hash(plain), verification_state: 'verified', active_for_grading: true };
  const manifest = createP2CriteriaManifest([
    { category: 'LAW', criterion: 'A', modelExcerpt: 'A' },
    { category: 'CONCLUSION', criterion: 'B', modelExcerpt: 'B' },
  ], { modelAnswer: source.answer, rubric: source.rubric });
  const input = { subjectId: 'CIVIL', stableKey: 'synthetic-item', expectedKeyVersion: 'v1',
    expectedPayloadDigest: hash(plain), expectedProblemVersionId: 'problem-v1',
    expectedProblemDigest: hash('synthetic prompt'), manifest,
    approvalEvidence: { approved: true, reviewId: 'synthetic-review', reviewerId: 'synthetic-reviewer',
      reviewedAt: '2026-01-01T00:00:00Z', criteriaDigest: manifest.criteriaDigest,
      originalPayloadDigest: hash(plain), problemDigest: hash('synthetic prompt') } };
  input.decisionRubric = { elements: manifest.requiredElements.map(element => ({ ...element,
    explanation: 'Synthetic explanation', requiredPropositions: ['Synthetic proposition'],
    matchCondition: 'All required', partialCondition: 'Some required', errorCondition: 'Contradiction',
    missingCondition: 'Absent' })), decompositionRationale: 'Two synthetic criteria',
    changesFromPrevious: '', unresolvedAmbiguities: [] };
  input.reviewEvidence = { sourceOnly: true, learnerAnswersProvidedToRubricReview: false,
    criteriaFile: 'synthetic-criteria', criteriaFileDigest: hash('criteria'), auditFile: 'synthetic-audit',
    auditFileDigest: hash('audit'), duplicateGroups: 0, unsupportedElements: 0, requiresRevision: false };
  input.approvalEvidence.decisionRubricDigest = p2PublicationDigest(input.decisionRubric);
  input.approvalEvidence.reviewEvidenceDigest = p2PublicationDigest(input.reviewEvidence);
  let rows = new Map([['v1', { ...original }]]), rollbackRows, auditCount = 0, rollbackAudits;
  const statements = [], settings = { failAudit: false };
  const client = { release() {}, async query(sql, values = []) {
    statements.push(sql);
    if (sql === 'BEGIN') { rollbackRows = new Map([...rows].map(([k,v]) => [k,{...v}])); rollbackAudits = auditCount; }
    if (sql === 'ROLLBACK') { rows = rollbackRows; auditCount = rollbackAudits; }
    if (sql.includes('FROM problems')) return { rowCount: 1, rows: [{ stage: 'P2',
      current_problem_version_id: 'problem-v1', content_digest: input.expectedProblemDigest }] };
    if (sql.includes('SELECT encrypted_payload')) {
      const row = rows.get(values[2]); return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
    }
    if (sql.includes('SELECT key_version')) {
      const active = [...rows].filter(([,row]) => row.active_for_grading)
        .map(([key_version]) => ({ key_version, encryption_key_id: encryptionKeyId }));
      return { rowCount: active.length, rows: active };
    }
    if (sql.includes('INSERT INTO private_grading_keys')) rows.set(values[2], {
      encrypted_payload: values[4], payload_digest: values[5], verification_state: 'verified', active_for_grading: false });
    if (sql.includes('UPDATE private_grading_keys')) rows.get(values[2]).active_for_grading = sql.includes('SET active_for_grading=true');
    if (sql.includes('INSERT INTO audit_events')) {
      if (settings.failAudit) throw new Error('synthetic audit failure');
      auditCount++;
    }
    return { rowCount: 1, rows: [] };
  } };
  return { input, original, settings, statements, pool: { connect: async () => client },
    options: { encryptionKey, encryptionKeyId }, rows: () => rows, audits: () => auditCount };
}

test('fixed criteria publication defaults to dry-run with no DML', async () => {
  const f = setup();
  const result = await publishP2FixedCriteria(f.pool, f.input, { ...f.options, activate: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.wouldInsert, true);
  assert.equal(result.wouldActivate, true);
  assert.equal(result.inserted, false);
  assert.equal(result.active, false);
  assert.equal(f.rows().size, 1);
  assert.ok(!f.statements.some(sql => /^\s*(INSERT|UPDATE|DELETE)\b/.test(sql)));
  assert.ok(f.statements.some(sql => sql.includes('pg_advisory_xact_lock')));
  assert.ok(f.statements.some(sql => sql.includes('FROM problems') && sql.includes('FOR UPDATE')));
});

test('append inactive verified version preserves original ciphertext and replays without writes', async () => {
  const f = setup(), opts = { ...f.options, dryRun: false };
  const first = await publishP2FixedCriteria(f.pool, f.input, opts);
  assert.equal(first.active, false);
  assert.equal(first.inserted, true);
  assert.deepEqual(f.rows().get('v1'), f.original);
  const row = f.rows().get(first.keyVersion);
  const decoded = decryptGradingPayload(row.encrypted_payload, opts.encryptionKey,
    gradingAad('CIVIL', 'synthetic-item', first.keyVersion, opts.encryptionKeyId), row.payload_digest);
  assert.equal(decoded.fixedCriteriaManifest.criteriaDigest, f.input.manifest.criteriaDigest);
  assert.equal(decoded.fixedCriteriaApproval.originalKeyVersion, 'v1');
  assert.equal(decoded.answer, 'A B');
  assert.deepEqual(decoded.fixedDecisionRubric, f.input.decisionRubric);
  assert.deepEqual(decoded.fixedCriteriaReviewEvidence, f.input.reviewEvidence);
  f.statements.length = 0;
  const replay = await publishP2FixedCriteria(f.pool, f.input, opts);
  assert.equal(replay.replayed, true);
  assert.equal(f.rows().size, 2);
  assert.equal(f.audits(), 1);
  assert.ok(!f.statements.some(sql => /^\s*(INSERT|UPDATE|DELETE)\b/.test(sql)));
});

test('explicit activation switches only flags and subsequent replay is idempotent', async () => {
  const f = setup(), opts = { ...f.options, dryRun: false, activate: true };
  const result = await publishP2FixedCriteria(f.pool, f.input, opts);
  assert.equal(result.active, true);
  assert.equal(f.rows().get('v1').active_for_grading, false);
  assert.deepEqual(f.rows().get('v1').encrypted_payload, f.original.encrypted_payload);
  assert.equal(f.rows().get('v1').payload_digest, f.original.payload_digest);
  assert.equal(f.rows().get(result.keyVersion).active_for_grading, true);
  assert.equal((await publishP2FixedCriteria(f.pool, f.input, opts)).replayed, true);
  assert.equal(f.audits(), 1);
  assert.ok(f.statements.filter(sql => sql.startsWith('UPDATE')).every(sql => /^UPDATE private_grading_keys SET active_for_grading=/.test(sql)));
});

test('stale snapshots, absent approval and undecryptable key fail closed', async () => {
  for (const patch of [
    { expectedProblemVersionId: 'changed' }, { expectedPayloadDigest: '0'.repeat(64) },
    { approvalEvidence: { approved: false } },
  ]) {
    const f = setup();
    await assert.rejects(publishP2FixedCriteria(f.pool, { ...f.input, ...patch }, { ...f.options, dryRun: false }));
    assert.equal(f.rows().size, 1);
    assert.equal(f.audits(), 0);
  }
  const f = setup();
  await assert.rejects(publishP2FixedCriteria(f.pool, f.input,
    { ...f.options, encryptionKey: crypto.randomBytes(32), dryRun: false }));
  assert.equal(f.statements.at(-1), 'ROLLBACK');
  assert.equal(f.rows().size, 1);
});

test('audit failure rolls back inserted version and activation', async () => {
  const f = setup(); f.settings.failAudit = true;
  await assert.rejects(publishP2FixedCriteria(f.pool, f.input,
    { ...f.options, dryRun: false, activate: true }), /synthetic audit failure/);
  assert.equal(f.statements.at(-1), 'ROLLBACK');
  assert.equal(f.rows().size, 1);
  assert.deepEqual(f.rows().get('v1'), f.original);
});

test('decision rule tampering, mismatched elements and unresolved review fail closed', async () => {
  for (const mutation of [
    input => { input.decisionRubric.elements[0].matchCondition = 'Changed after approval'; },
    input => { input.decisionRubric.elements.pop(); },
    input => { input.decisionRubric.elements[0].partialCondition = 'x'.repeat(5001); },
    input => { input.reviewEvidence.requiresRevision = true; },
  ]) {
    const f = setup(); mutation(f.input);
    await assert.rejects(publishP2FixedCriteria(f.pool,f.input,{...f.options,dryRun:false}));
    assert.equal(f.rows().size,1);
    assert.equal(f.audits(),0);
  }
});
