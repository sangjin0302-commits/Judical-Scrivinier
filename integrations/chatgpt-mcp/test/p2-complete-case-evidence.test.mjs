import test from 'node:test';
import assert from 'node:assert/strict';
import { validateP2CompleteCaseEvidence as validate, p2CompleteCaseEvidenceDigest as hash } from '../db/p2-complete-case-evidence.mjs';
const now = Date.parse('2026-10-31T00:00:00.000Z');
function fixture() {
  const bindings = [1, 2].map(i => ({ stableKey: `synthetic-${i}`, problemVersionId: `version-${i}`, promptDigest: hash(`prompt${i}`), sourceDigest: hash(`source${i}`), criteriaDigest: hash(`criteria${i}`), decisionRubricDigest: hash(`decision${i}`) }));
  const scope = { subjectId: 'CIVIL', caseId: 'synthetic-case', commonFactsDigest: hash('facts'), bindings };
  const scopeDigest = hash(scope), testSuiteDigest = hash('independent-suite');
  const receipt = { runId: 'synthetic-run', modelId: 'synthetic-model', executedAt: '2026-10-30T00:00:00.000Z', actualInvocation: true, scopeDigest, testSuiteDigest, requestDigest: hash('request'), responseDigest: hash('response'), resultDigest: hash('result'), passed: true, testCount: 9, failureCount: 0, coverage: { full: 3, equivalent: 3, partial: 1, wrong: 1, abstain: 1 } };
  const evidence = { schemaVersion: 1, ...scope, generatorId: 'generator', audit: { reviewerId: 'independent-reviewer', scopeDigest, artifactDigest: hash('audit'), completeCaseReviewed: true, approved: true, ambiguityCount: 0, missingMeaningCount: 0, unsupportedElementCount: 0, duplicateCount: 0 }, benchmark: { scopeDigest, testSuiteDigest, receipts: [receipt] } };
  const expected = structuredClone({ ...scope, generatorId: 'generator', reviewerId: 'independent-reviewer', auditArtifactDigest: hash('audit'), testSuiteDigest, receipts: [receipt] });
  return { evidence, expected };
}
test('complete synthetic evidence returns only bindings and counts', () => {
  const { evidence, expected } = fixture();
  assert.deepEqual(Object.keys(validate(evidence, expected, { now })).sort(), ['approved', 'evidenceDigest', 'itemCount', 'modelRunCount', 'scopeDigest']);
  assert.equal(validate(evidence, expected, { now }).itemCount, 2);
});
test('missing fields fail closed at every required level', () => {
  const sample = fixture().evidence;
  for (const path of [[], ['audit'], ['benchmark'], ['bindings', 0], ['benchmark', 'receipts', 0]]) {
    let obj = sample; for (const k of path) obj = obj[k];
    for (const key of Object.keys(obj)) {
      const { evidence, expected } = fixture(); let target = evidence;
      for (const k of path) target = target[k]; delete target[key];
      assert.throws(() => validate(evidence, expected, { now }));
    }
  }
});
test('partial, duplicated, foreign and stale source bindings rejected', () => {
  for (const mutate of [e => e.bindings.pop(), e => e.bindings.push(e.bindings[0]), e => e.caseId = 'other', e => e.commonFactsDigest = hash('changed'), ...['stableKey', 'problemVersionId', 'promptDigest', 'sourceDigest', 'criteriaDigest', 'decisionRubricDigest'].map(k => e => e.bindings[0][k] = hash('changed'))]) {
    const { evidence, expected } = fixture(); mutate(evidence); assert.throws(() => validate(evidence, expected, { now }));
  }
});
test('independent positive complete audit required', () => {
  for (const [key, value] of [['reviewerId', 'generator'], ['approved', false], ['completeCaseReviewed', false], ['ambiguityCount', 1], ['missingMeaningCount', 1], ['unsupportedElementCount', 1], ['duplicateCount', 1], ['artifactDigest', hash('changed')]]) {
    const { evidence, expected } = fixture(); evidence.audit[key] = value; assert.throws(() => validate(evidence, expected, { now }));
  }
});
test('unexecuted, failed, future, invalid and forged receipts rejected', () => {
  for (const [key, value] of [['actualInvocation', false], ['passed', false], ['failureCount', 1], ['testCount', 0], ['executedAt', '2026-11-01T00:00:00.000Z'], ['executedAt', '2026-02-30T00:00:00.000Z'], ['runId', 'forged'], ['responseDigest', hash('forged')], ['scopeDigest', hash('stale')], ['testSuiteDigest', hash('stale')]]) {
    const { evidence, expected } = fixture(); evidence.benchmark.receipts[0][key] = value; assert.throws(() => validate(evidence, expected, { now }));
  }
  for (const receipts of [[], null]) { const { evidence, expected } = fixture(); evidence.benchmark.receipts = receipts; assert.throws(() => validate(evidence, expected, { now })); }
});
test('unknown fields and duplicate runs rejected; input remains unchanged', () => {
  const { evidence, expected } = fixture(); const original = structuredClone(evidence);
  validate(evidence, expected, { now }); assert.deepEqual(evidence, original);
  evidence.benchmark.receipts.push(evidence.benchmark.receipts[0]); assert.throws(() => validate(evidence, expected, { now }));
  const next = fixture(); next.evidence.privateAnswer = 'forbidden'; assert.throws(() => validate(next.evidence, next.expected, { now }));
});
test('coverage omissions and insufficient repeats rejected even in trusted receipt', () => {
  for (const category of ['full', 'equivalent', 'partial', 'wrong', 'abstain']) {
    const { evidence, expected } = fixture();
    evidence.benchmark.receipts[0].coverage[category]--;
    evidence.benchmark.receipts[0].testCount--;
    expected.receipts = structuredClone(evidence.benchmark.receipts);
    assert.throws(() => validate(evidence, expected, { now }));
  }
  const { evidence, expected } = fixture();
  evidence.benchmark.receipts[0].testCount++;
  expected.receipts = structuredClone(evidence.benchmark.receipts);
  assert.throws(() => validate(evidence, expected, { now }));
});
