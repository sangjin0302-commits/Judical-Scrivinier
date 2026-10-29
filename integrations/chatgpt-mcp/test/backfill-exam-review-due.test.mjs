import assert from "node:assert/strict";
import test from "node:test";

import { backfillExamReviewDue } from "../db/backfill-exam-review-due.mjs";

test("dry-run reads aggregate history only and leaves due table untouched", async () => {
  const statements = [];
  const client = { async query(sql) {
    statements.push(sql);
    if (sql.includes("AS history_groups")) return { rows: [{ history_groups: 4,
      verified_groups: 2, missing_due_groups: 1 }] };
    return { rowCount: 0, rows: [] };
  }, release() {} };
  const result = await backfillExamReviewDue({ async connect() { return client; } });
  assert.deepEqual(result, { ok: true, applied: false, historyGroups: 4, verifiedGroups: 2,
    ambiguousGroups: 2, missingBefore: 1, inserted: 0, missingAfter: 1 });
  assert.equal(statements[0], "BEGIN READ ONLY");
  assert.equal(statements.at(-1), "COMMIT");
  assert.equal(statements.some((sql) => sql.startsWith("INSERT")), false);
  const inventory = statements.find((sql) => sql.includes("AS history_groups"));
  assert.match(inventory, /FROM original_answers answer/);
  assert.match(inventory, /length\(btrim\(answer.answer_text\)\)>0/);
  assert.equal(inventory.includes("SELECT answer_text"), false);
  assert.equal(inventory.includes("encrypted_payload"), false);
});

test("apply is idempotent and rolls back on a failed insert", async () => {
  const statements = [];
  let inventory = 0;
  const client = { async query(sql) {
    statements.push(sql);
    if (sql.includes("AS history_groups")) return { rows: [{ history_groups: 2,
      verified_groups: 1, missing_due_groups: inventory++ ? 0 : 1 }] };
    if (sql.includes("INSERT INTO exam_review_due")) return { rowCount: 1, rows: [] };
    return { rowCount: 0, rows: [] };
  }, release() {} };
  const result = await backfillExamReviewDue({ async connect() { return client; } }, { apply: true });
  assert.equal(result.inserted, 1);
  assert.equal(result.missingAfter, 0);
  assert.match(statements.find((sql) => sql.includes("INSERT INTO exam_review_due")), /ON CONFLICT.*DO NOTHING/s);
  assert.equal(statements.at(-1), "COMMIT");
  const failed = [];
  const broken = { async query(sql) {
    failed.push(sql);
    if (sql.includes("AS history_groups")) return { rows: [{ history_groups: 1,
      verified_groups: 1, missing_due_groups: 1 }] };
    if (sql.includes("INSERT INTO exam_review_due")) throw new Error("synthetic failure");
    return { rows: [] };
  }, release() {} };
  await assert.rejects(backfillExamReviewDue({ async connect() { return broken; } }, { apply: true }),
    /synthetic failure/);
  assert.equal(failed.at(-1), "ROLLBACK");
});
