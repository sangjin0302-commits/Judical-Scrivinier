const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'apps-script/pb1-fast-safe/PB1FastSafe.gs'), 'utf8');
const html = fs.readFileSync(path.join(root, 'apps-script/pb1-fast-safe/PB1FastSafeUI.html'), 'utf8');

test('completed request mapping is written only after publication verification', () => {
  const publicationCheck = source.indexOf('PB1F_validateSetRows_(published, pending, true, true)');
  const completedWrite = source.indexOf("props.setProperty(issueKey, JSON.stringify(pending))", publicationCheck);
  assert.ok(publicationCheck >= 0);
  assert.ok(completedWrite > publicationCheck);
});

test('retry, ownership, publication and answer-conflict guards are present', () => {
  assert.match(source, /PB1F_resumeIssue_/);
  assert.match(source, /다른 사용자의 세트 접근 차단/);
  assert.match(source, /owner \+ ':' \+ requestId/);
  assert.match(source, /PB1F_validateSetRows_\(indexed\.map/);
  assert.match(source, /서로 다른 답안 재제출 거부/);
  assert.match(source, /다음 행 포인터가 기존 기록을 가리킴/);
  assert.match(source, /String\(row\[6\]\)\.trim\(\) !== '확정'/);
});

test('browser preserves the pending request id across a failed issue call', () => {
  assert.match(html, /sessionStorage\.getItem\('pb1fPendingRequestId'\)/);
  assert.match(html, /sessionStorage\.setItem\('pb1fPendingRequestId'/);
  assert.match(html, /sessionStorage\.removeItem\('pb1fPendingRequestId'\)/);
});

test('answer normalization accepts only O and X', () => {
  const context = {
    Object,
    String,
    Error,
    Set,
    Math,
    Date,
    JSON,
    Number,
    Array,
    Utilities: {},
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  assert.equal(context.PB1F_normalizeAnswer_(' o '), 'O');
  assert.equal(context.PB1F_normalizeAnswer_('X'), 'X');
  assert.throws(() => context.PB1F_normalizeAnswer_('yes'), /O\/X/);
});
