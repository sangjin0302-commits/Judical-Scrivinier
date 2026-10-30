// Synthetic fixture only; fresh disposable localhost database required.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { gradingAad } from '../db/postgres-adapter.mjs';
import { createP2CriteriaManifest } from '../db/p2-fixed-criteria.mjs';
import { publishP2FixedCriteria, p2PublicationDigest } from '../db/publish-p2-fixed-criteria.mjs';
const url = new URL(process.env.TEST_DATABASE_URL || 'http://invalid');
if (!['localhost','127.0.0.1'].includes(url.hostname) || url.port !== '55432' ||
    !/^exam_flow_[a-z0-9_]+$/i.test(url.pathname.slice(1))) throw new Error('requires fresh disposable localhost exam_flow_* database');
const pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const encryptionKey = crypto.randomBytes(32), encryptionKeyId = 'synthetic-publisher';
const stableKey = 'SYNTH|2025-제1회-문1-소문항1';
const source = { answer: 'A B', rubric: 'A B' }, plain = JSON.stringify(source);
const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
cipher.setAAD(gradingAad('CIVIL', stableKey, 'v1', encryptionKeyId));
const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
const bytes = Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
try {
  assert.equal((await pool.query("SELECT to_regclass('public.problems') AS name")).rows[0].name, null);
  for (const name of ['0001_learning_ledger.sql','0002_grading_key_rotation.sql','0004_google_docs_sync.sql']) {
    await pool.query(await readFile(new URL(`../db/migrations/${name}`, import.meta.url), 'utf8'));
  }
  await pool.query("INSERT INTO subjects(subject_id,name) VALUES('CIVIL','Synthetic')");
  await pool.query("INSERT INTO source_documents(document_id,subject_id,title) VALUES('synthetic','CIVIL','Synthetic')");
  await pool.query(`INSERT INTO document_revisions(document_id,revision_id,content_digest,parser_version,parsed_problem_count)
    VALUES('synthetic','r1','synthetic','test',1)`);
  await pool.query(`INSERT INTO problems(subject_id,stable_key,stage,source_order,source_ref,source_version,prompt_text,max_points,published,content_digest)
    VALUES('CIVIL',$1,'P2',1,'synthetic','v1','Synthetic prompt',10,true,$2)`, [stableKey, hash('Synthetic prompt')]);
  const version = (await pool.query(`INSERT INTO problem_versions(subject_id,stable_key,source_document_id,source_revision_id,
    source_version,stage,source_order,prompt_text,max_points,prompt_digest)
    VALUES('CIVIL',$1,'synthetic','r1','v1','P2',1,'Synthetic prompt',10,$2) RETURNING version_id`,
  [stableKey,hash('Synthetic prompt')])).rows[0].version_id;
  await pool.query("UPDATE problems SET current_problem_version_id=$1 WHERE stable_key=$2", [version,stableKey]);
  await pool.query(`INSERT INTO private_grading_keys(subject_id,stable_key,key_version,encryption_key_id,
    encrypted_payload,payload_digest,verification_state,active_for_grading) VALUES('CIVIL',$1,'v1',$2,$3,$4,'verified',true)`,
  [stableKey,encryptionKeyId,bytes,hash(plain)]);
  const manifest = createP2CriteriaManifest([
    { category:'LAW',criterion:'A',modelExcerpt:'A' },{ category:'CONCLUSION',criterion:'B',modelExcerpt:'B' },
  ], {modelAnswer:source.answer,rubric:source.rubric});
  const input = {subjectId:'CIVIL',stableKey,expectedKeyVersion:'v1',expectedPayloadDigest:hash(plain),
    expectedProblemVersionId:version,expectedProblemDigest:hash('Synthetic prompt'),manifest,
    approvalEvidence:{approved:true,reviewId:'synthetic-review',reviewerId:'synthetic-reviewer',
      reviewedAt:'2026-01-01T00:00:00Z',criteriaDigest:manifest.criteriaDigest,
      originalPayloadDigest:hash(plain),problemDigest:hash('Synthetic prompt')}};
  const opts = {encryptionKey,encryptionKeyId};
  input.decisionRubric = { elements: manifest.requiredElements.map(element => ({...element,
    explanation:'Synthetic explanation',requiredPropositions:['Synthetic proposition'],
    matchCondition:'All required',partialCondition:'Some required',errorCondition:'Contradiction',missingCondition:'Absent'})),
    decompositionRationale:'Two criteria',changesFromPrevious:'',unresolvedAmbiguities:[] };
  input.reviewEvidence = {sourceOnly:true,learnerAnswersProvidedToRubricReview:false,
    criteriaFile:'synthetic-criteria',criteriaFileDigest:hash('criteria'),auditFile:'synthetic-audit',
    auditFileDigest:hash('audit'),duplicateGroups:0,unsupportedElements:0,requiresRevision:false};
  input.approvalEvidence.decisionRubricDigest = p2PublicationDigest(input.decisionRubric);
  input.approvalEvidence.reviewEvidenceDigest = p2PublicationDigest(input.reviewEvidence);
  const before = await pool.query("SELECT key_version,encode(encrypted_payload,'hex') AS encrypted,payload_digest FROM private_grading_keys");
  const dry = await publishP2FixedCriteria(pool,input,{...opts,activate:true});
  assert.equal(dry.wouldActivate,true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM private_grading_keys')).rows[0].n,1);
  // Both independent callers serialize; exactly one append/activation/audit occurs.
  const results = await Promise.all([1,2].map(() => publishP2FixedCriteria(pool,input,{...opts,dryRun:false,activate:true})));
  assert.equal(results.filter(x=>x.replayed).length,1);
  assert.equal(new Set(results.map(x=>x.keyVersion)).size,1);
  const state = await pool.query("SELECT key_version,active_for_grading,encode(encrypted_payload,'hex') AS encrypted,payload_digest FROM private_grading_keys");
  assert.equal(state.rowCount,2);
  assert.equal(state.rows.filter(x=>x.active_for_grading).length,1);
  const old = state.rows.find(x=>x.key_version==='v1');
  assert.equal(old.encrypted,before.rows[0].encrypted);
  assert.equal(old.payload_digest,before.rows[0].payload_digest);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action='P2_FIXED_CRITERIA_PUBLISH'")).rows[0].n,1);
  // Bind to the exact version, not merely to an unchanged question string.
  await assert.rejects(publishP2FixedCriteria(pool,{...input,expectedProblemVersionId:crypto.randomUUID()},
    {...opts,dryRun:false,activate:true}),/problem snapshot changed/);
  await assert.rejects(publishP2FixedCriteria(pool,input,{...opts,encryptionKey:crypto.randomBytes(32),dryRun:false}));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM private_grading_keys')).rows[0].n,2);
  process.stdout.write(JSON.stringify({ok:true,dryRunNoWrites:true,concurrentAppendReplay:true,
    originalCiphertextPreserved:true,oneActiveKey:true,staleSourceRejected:true,wrongKeyRejected:true})+'\n');
} finally { encryptionKey.fill(0); await pool.end(); }
