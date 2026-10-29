const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const pb1 = fs.readFileSync(path.join(root, 'apps-script/pb1-fast-safe/PB1FastSafe.gs'), 'utf8');
const p2 = fs.readFileSync(path.join(root, 'apps-script/pb1-fast-safe/P2FastSafe.gs'), 'utf8');
const context = { Object, String, Error, Set, Math, Date, JSON, Number, Array, Utilities: {} };
vm.createContext(context);
vm.runInContext(`${pb1}\n${p2}`, context);

test('partial row recovery writes only blank runs and rejects conflicts before write', () => {
  const expected = ['key', 'set', 100, 'answer', '채점완료', 3, 20, '아니오', 1, '복합 오류', '사례포섭', ''];
  const partial = expected.slice(0, 7).concat(['', '', '', '', '']);
  const runs = context.P2F_planRow_(849, partial, expected, [...Array(12).keys()], '풀이이력');
  assert.deepEqual(JSON.parse(JSON.stringify(runs)), [{ row: 849, start: 7, values: expected.slice(7) }]);
  const conflict = partial.slice();
  conflict[5] = 4;
  assert.throws(() => context.P2F_planRow_(849, conflict, expected, [...Array(12).keys()], '풀이이력'), /풀이이력 기존 값 충돌/);
});

test('P2 evaluation validates live-list values and seven scores', () => {
  const record = { keys: ['k1'] };
  const allowed = { errorTypes: ['없음', '복합 오류'], checkTypes: ['사례포섭', '해당없음'], reviewTypes: ['사례형 재작성'] };
  const base = { key: 'k1', maxPoints: 20, awardedPoints: 3,
    scores: { issue: 1, outline: 1, law: 0, precedent: 0, application: 0, conclusion: 1, expression: 1 },
    errorType: '복합 오류', checkType: '사례포섭', nextReview: '사례형 재작성' };
  assert.equal(context.P2F_evaluations_({ evaluations: [base] }, record, allowed)[0].checkType, '사례포섭');
  assert.throws(() => context.P2F_evaluations_({ evaluations: [{ ...base, checkType: '2차 사례형' }] }, record, allowed), /허용값 위반/);
  assert.throws(() => context.P2F_evaluations_({ evaluations: [{ ...base, nextReview: '자유문' }] }, record, allowed), /허용값 위반/);
});
