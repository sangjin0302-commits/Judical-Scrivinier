import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const schema = readFileSync(new URL("../integrations/chatgpt-mcp/db/migrations/0001_learning_ledger.sql", import.meta.url), "utf8");
const contract = readFileSync(new URL("../integrations/chatgpt-mcp/db/test/transaction_contract.sql", import.meta.url), "utf8");

test("ledger preserves stable keys and isolates every subject relation", () => {
  assert.match(schema, /PRIMARY KEY \(subject_id, stable_key\)/);
  assert.match(schema, /FOREIGN KEY \(set_id, subject_id\) REFERENCES issue_sets\(set_id, subject_id\)/);
  assert.match(schema, /FOREIGN KEY \(submission_id, subject_id\) REFERENCES submissions\(submission_id, subject_id\)/);
  assert.match(contract, /cross-subject item was accepted/);
});

test("one set permits one committed submission and one row per problem", () => {
  assert.match(schema, /UNIQUE \(set_id\)/);
  assert.match(schema, /PRIMARY KEY \(submission_id, stable_key\)/);
  assert.match(schema, /UNIQUE \(owner_id, subject_id, stage, request_id\)/);
});

test("original answers and grades are append-only", () => {
  for (const table of ["original_answers", "p1_grades", "p2_grades"]) {
    assert.match(schema, new RegExp(`CREATE TRIGGER ${table}_append_only`));
  }
  assert.match(contract, /original answer mutation was accepted/);
});

test("P2 retains all seven bounded evaluation elements", () => {
  for (const element of ["issue", "outline", "law", "precedent", "application", "conclusion", "expression"]) {
    assert.match(schema, new RegExp(`${element}_score smallint NOT NULL CHECK \\(${element}_score BETWEEN 0 AND 2\\)`));
  }
});

test("transactional outbox and unique sheet receipt protect projection retries", () => {
  assert.match(schema, /CREATE TABLE sheet_outbox/);
  assert.match(schema, /CREATE TABLE sheet_sync_receipts/);
  assert.match(schema, /UNIQUE \(spreadsheet_id, sheet_name, external_record_key\)/);
  assert.match(contract, /outbox contract mismatch/);
});
