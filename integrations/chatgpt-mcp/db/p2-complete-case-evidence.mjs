import { createHash } from 'node:crypto';

const fail = () => { throw new Error('complete-case evidence rejected'); };
const record = v => v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const exact = (v, keys) => {
  if (!record(v) || Object.keys(v).sort().join('|') !== [...keys].sort().join('|')) fail();
};
const identity = v => { if (typeof v !== 'string' || !v.trim() || v !== v.trim() || v.length > 200) fail(); };
const digest = v => { if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) fail(); };
const canonical = v => JSON.stringify(sort(v));
function sort(v) {
  if (Array.isArray(v)) return v.map(sort);
  if (record(v)) return Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])]));
  return v;
}
export const p2CompleteCaseEvidenceDigest = v => createHash('sha256').update(canonical(v)).digest('hex');
const bindingKeys = ['stableKey', 'problemVersionId', 'promptDigest', 'sourceDigest', 'criteriaDigest', 'decisionRubricDigest'];
function bindings(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 200) fail();
  const seen = new Set();
  for (const item of items) {
    exact(item, bindingKeys);
    identity(item.stableKey); identity(item.problemVersionId);
    for (const k of ['promptDigest', 'sourceDigest', 'criteriaDigest', 'decisionRubricDigest']) digest(item[k]);
    if (seen.has(item.stableKey)) fail();
    seen.add(item.stableKey);
  }
  return [...items].sort((a, b) => a.stableKey.localeCompare(b.stableKey));
}

/** Optional maintenance gate; no existing publication or replay behavior changes.
 * expected MUST come from independently verified source inventory, reviewer policy,
 * and actual model-run receipt registry, never from the proposed evidence itself.
 * Hash equality binds artifacts; it cannot establish legal correctness or prove a
 * model ran without that trusted registry. No answer text is accepted or returned.
 */
export function validateP2CompleteCaseEvidence(evidence, expected, { now = Date.now() } = {}) {
  exact(evidence, ['schemaVersion', 'subjectId', 'caseId', 'commonFactsDigest', 'bindings', 'generatorId', 'audit', 'benchmark']);
  exact(expected, ['subjectId', 'caseId', 'commonFactsDigest', 'bindings', 'generatorId', 'reviewerId', 'auditArtifactDigest', 'testSuiteDigest', 'receipts']);
  if (evidence.schemaVersion !== 1 || !Number.isFinite(now)) fail();
  for (const k of ['subjectId', 'caseId', 'generatorId']) {
    identity(evidence[k]); identity(expected[k]);
    if (evidence[k] !== expected[k]) fail();
  }
  digest(evidence.commonFactsDigest); digest(expected.commonFactsDigest);
  if (evidence.commonFactsDigest !== expected.commonFactsDigest) fail();
  const items = bindings(evidence.bindings), wanted = bindings(expected.bindings);
  if (canonical(items) !== canonical(wanted)) fail();
  const scopeDigest = p2CompleteCaseEvidenceDigest({ subjectId: evidence.subjectId, caseId: evidence.caseId, commonFactsDigest: evidence.commonFactsDigest, bindings: items });
  const audit = evidence.audit;
  exact(audit, ['reviewerId', 'scopeDigest', 'artifactDigest', 'completeCaseReviewed', 'approved', 'ambiguityCount', 'missingMeaningCount', 'unsupportedElementCount', 'duplicateCount']);
  identity(audit.reviewerId); identity(expected.reviewerId);
  digest(audit.scopeDigest); digest(audit.artifactDigest); digest(expected.auditArtifactDigest);
  if (audit.reviewerId !== expected.reviewerId || audit.reviewerId === evidence.generatorId ||
      audit.scopeDigest !== scopeDigest || audit.artifactDigest !== expected.auditArtifactDigest ||
      audit.completeCaseReviewed !== true || audit.approved !== true) fail();
  for (const k of ['ambiguityCount', 'missingMeaningCount', 'unsupportedElementCount', 'duplicateCount']) if (audit[k] !== 0) fail();
  const bench = evidence.benchmark;
  exact(bench, ['scopeDigest', 'testSuiteDigest', 'receipts']);
  digest(bench.scopeDigest); digest(bench.testSuiteDigest); digest(expected.testSuiteDigest);
  if (bench.scopeDigest !== scopeDigest || bench.testSuiteDigest !== expected.testSuiteDigest) fail();
  const receiptKeys = ['runId', 'modelId', 'executedAt', 'actualInvocation', 'scopeDigest', 'testSuiteDigest', 'requestDigest', 'responseDigest', 'resultDigest', 'passed', 'testCount', 'failureCount', 'coverage'];
  const checkReceipts = values => {
    if (!Array.isArray(values) || values.length < 1 || values.length > 100) fail();
    const ids = new Set();
    for (const r of values) {
      exact(r, receiptKeys); identity(r.runId); identity(r.modelId);
      if (ids.has(r.runId)) fail(); ids.add(r.runId);
      if (typeof r.executedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.executedAt)) fail();
      const at = Date.parse(r.executedAt);
      if (!Number.isFinite(at) || new Date(at).toISOString() !== r.executedAt || at > now) fail();
      for (const k of ['scopeDigest', 'testSuiteDigest', 'requestDigest', 'responseDigest', 'resultDigest']) digest(r[k]);
      if (r.scopeDigest !== scopeDigest || r.testSuiteDigest !== bench.testSuiteDigest || r.actualInvocation !== true ||
          r.passed !== true || !Number.isSafeInteger(r.testCount) || r.testCount < 1 || r.failureCount !== 0) fail();
      exact(r.coverage, ['full', 'equivalent', 'partial', 'wrong', 'abstain']);
      for (const [category, count] of Object.entries(r.coverage)) {
        if (!Number.isSafeInteger(count) || count < (['full', 'equivalent'].includes(category) ? 3 : 1)) fail();
      }
      if (Object.values(r.coverage).reduce((a, b) => a + b, 0) !== r.testCount) fail();
    }
    return [...values].sort((a, b) => a.runId.localeCompare(b.runId));
  };
  if (canonical(checkReceipts(bench.receipts)) !== canonical(checkReceipts(expected.receipts))) fail();
  return Object.freeze({ approved: true, scopeDigest, evidenceDigest: p2CompleteCaseEvidenceDigest(evidence), itemCount: items.length, modelRunCount: bench.receipts.length });
}
