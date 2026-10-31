import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import { buildCurriculumSnapshot, parseCsv } from "../db/import-concept-curriculum.mjs";
import { validateRecallIssueLinks } from "../db/import-recall-issue-links.mjs";

const root = resolve(import.meta.dirname, "../../..");

test("all 21 source-mapped recall questions link to classified same-unit issues", async () => {
  const snapshot = await buildCurriculumSnapshot(root);
  const links = parseCsv(await readFile(resolve(root, "curriculum/recall-question-issue-links.csv"), "utf8"));
  const questions = snapshot.units.flatMap((unit) => unit.listedIds.map((questionId) => ({
    question_id: questionId, unit_id: unit.unit_id,
    content_state: unit.recallText ? "source-mapped" : "template-unverified",
  })));
  const issues = snapshot.issues.filter((issue) => ["A", "B", "C"].includes(issue.learning_tier))
    .map((issue) => ({ issue_id: issue.issue_id, unit_id: issue.unit_id }));
  assert.equal(validateRecallIssueLinks(links, questions, issues).length, 21);
  assert.equal(new Set(links.map((item) => item.question_id)).size, 21);
  assert.equal(questions.length, 720);
  assert.equal(questions.filter((item) => item.content_state === "source-mapped").length, 21);
});

test("wrong-unit or unverified template links fail closed", async () => {
  const links = parseCsv(await readFile(resolve(root, "curriculum/recall-question-issue-links.csv"), "utf8"));
  const questions = links.map((item) => ({ question_id: item.question_id,
    unit_id: item.question_id.slice(0, -3), content_state: "source-mapped" }));
  const issues = links.map((item) => ({ issue_id: item.issue_id,
    unit_id: item.issue_id.slice(0, -4) }));
  assert.equal(validateRecallIssueLinks(links, questions, issues).length, 21);
  assert.throws(() => validateRecallIssueLinks([{ ...links[0], issue_id: links.at(-1).issue_id }, ...links.slice(1)],
    questions, issues), /source mismatch/);
  assert.throws(() => validateRecallIssueLinks(links, [{ ...questions[0], content_state: "template-unverified" },
    ...questions.slice(1)], issues), /source mismatch/);
});
