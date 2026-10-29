import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { validateConceptToolInput } from "../concept-tools.mjs";
import { calculateNextReview, createConceptExecutor } from "../db/concept-service.mjs";
import { buildCurriculumSnapshot, parseCsv, parseNumberedQuestions, splitLessonLayers } from "../db/import-concept-curriculum.mjs";

test("curriculum snapshot preserves 240 units and 720 stable recall ids without inventing missing content", async () => {
  const root = resolve(import.meta.dirname, "../../..");
  const snapshot = await buildCurriculumSnapshot(root);
  assert.equal(snapshot.units.length, 240);
  assert.equal(snapshot.units.reduce((sum, unit) => sum + unit.listedIds.length, 0), 720);
  assert.equal(new Set(snapshot.units.flatMap((unit) => unit.listedIds)).size, 720);
  assert.equal(snapshot.units.filter((unit) => unit.lessonText).length, 7);
  assert.equal(snapshot.units.filter((unit) => unit.recallText).length, 7);
  assert.equal(snapshot.units.filter((unit) => !unit.lessonText).length, 233);
  assert.ok(snapshot.units.filter((unit) => unit.recallText).every((unit) => unit.parsedQuestions.length >= 3));
  assert.ok(snapshot.units.filter((unit) => !unit.recallText).every((unit) => unit.parsedQuestions.length === 0));
});

test("CSV and Markdown parsers keep source text and split instructional layers", () => {
  assert.deepEqual(parseCsv('\uFEFFa,b\n"x,y","z"\n'), [{ a: "x,y", b: "z" }]);
  assert.deepEqual(parseNumberedQuestions("1. one\n2. two\nnot a question"), ["one", "two"]);
  assert.deepEqual(splitLessonLayers("## 1층: 핵심\nfirst\n## 2층: 보충\nsecond\n## 공통 — 확인\ncommon"),
    { first: "first", second: "second", common: "common" });
});

test("review intervals follow remembered, partial, and relearn contract", () => {
  const now = new Date("2026-10-28T00:00:00.000Z");
  const rule = { rememberedDays: [1, 7, 21, 60], partialDays: 3, relearnDays: 1 };
  assert.equal(calculateNextReview("REMEMBERED", 0, rule, now).intervalDays, 1);
  assert.equal(calculateNextReview("REMEMBERED", 1, rule, now).intervalDays, 7);
  assert.equal(calculateNextReview("REMEMBERED", 2, rule, now).intervalDays, 21);
  assert.equal(calculateNextReview("REMEMBERED", 3, rule, now).intervalDays, 60);
  assert.equal(calculateNextReview("REMEMBERED", 9, rule, now).intervalDays, 60);
  assert.equal(calculateNextReview("PARTIAL", 3, rule, now).intervalDays, 3);
  assert.equal(calculateNextReview("RELEARN", 3, rule, now).intervalDays, 1);
  assert.equal(calculateNextReview("PARTIAL", 3, rule, now).rememberedCount, 0);
  assert.equal(calculateNextReview("PARTIAL", 3, rule, now).nextReviewAt.toISOString(), "2026-10-31T00:00:00.000Z");
});

test("concept tool validation keeps modes and real recall evidence separate", () => {
  assert.deepEqual(validateConceptToolInput("setCivilStudyMode", { mode: "CONCEPT_ONLY" }), { mode: "CONCEPT_ONLY" });
  assert.deepEqual(validateConceptToolInput("getCivilDueReviews", {}), { limit: 10 });
  assert.deepEqual(validateConceptToolInput("submitCivilRecall", {
    requestId: "r-1", questionId: "B1-Q1", answerText: "actual answer", memoryResult: "PARTIAL",
  }), { requestId: "r-1", questionId: "B1-Q1", answerText: "actual answer", memoryResult: "PARTIAL", evidence: {} });
  assert.throws(() => validateConceptToolInput("setCivilStudyMode", { mode: "FAST" }), /invalid mode/);
  assert.throws(() => validateConceptToolInput("submitCivilRecall", {
    requestId: "r-1", questionId: "B1-Q1", answerText: "", memoryResult: "REMEMBERED",
  }), /invalid recall input/);
  assert.deepEqual(validateConceptToolInput("recordCivilStudyActivity", {
    requestId: "activity-1", unitId: "B1-P0008-0011", activityType: "BOOK_READ", userConfirmed: true,
  }), { requestId: "activity-1", unitId: "B1-P0008-0011", activityType: "BOOK_READ", userConfirmed: true });
  assert.throws(() => validateConceptToolInput("recordCivilStudyActivity", {
    requestId: "activity-1", unitId: "B1-P0008-0011", activityType: "BOOK_READ", userConfirmed: false,
  }), /invalid study activity input/);
});

test("study activity ledger keeps user confirmation separate from recall and official score", async () => {
  const migration = await readFile(new URL("../db/migrations/0006_study_activity.sql", import.meta.url), "utf8");
  assert.match(migration, /concept_study_activities_append_only/);
  assert.match(migration, /USER_CONFIRMED/);
  assert.doesNotMatch(migration, /REMEMBERED|awarded_points/);
});

test("concept schema and due query track review streak per recall question", async () => {
  const migration = await readFile(new URL("../db/migrations/0003_concept_learning.sql", import.meta.url), "utf8");
  const service = await readFile(new URL("../db/concept-service.mjs", import.meta.url), "utf8");
  assert.match(migration, /remembered_count integer NOT NULL/);
  assert.match(service, /DISTINCT ON \(a\.question_id\)/);
  assert.match(service, /WHERE owner_id=\$1 AND subject_id=\$2 AND question_id=\$3/);
});

test("unverified recall templates stay out of lessons, due reviews, and new answer records", async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes("FROM units u")) return { rowCount: 1, rows: [{ unit_id: "U1", study_mode: "CONCEPT_ONLY" }] };
      if (sql.includes("to_regclass")) return { rowCount: 1, rows: [{ available: false }] };
      if (sql.includes("FROM recall_questions") && sql.includes("question_order")) return { rowCount: 2, rows: [
        { question_id: "U1-Q1", content_state: "source-mapped", prompt_text: "검증된 질문" },
        { question_id: "U1-Q2", content_state: "template-unverified", prompt_text: "미검증 템플릿" },
      ] };
      if (sql.includes("FROM latest l")) return { rowCount: 2, rows: [
        { question_id: "U1-Q1", content_state: "source-mapped" },
        { question_id: "U1-Q2", content_state: "template-unverified" },
      ] };
      if (sql.includes("FROM recall_attempts WHERE owner_id=$1") && sql.includes("request_id=$3")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("SELECT unit_id,content_state FROM recall_questions")) {
        return { rowCount: 1, rows: [{ unit_id: "U1", content_state: "template-unverified" }] };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  const tool = createConceptExecutor({ pool: { connect: async () => client } });
  const ctx = { ownerId: "owner-1" };
  const unit = await tool("getCivilConceptUnit", { unitId: "U1", mode: "CONCEPT_ONLY" }, ctx);
  assert.deepEqual(unit.recallQuestions.map((row) => row.question_id), ["U1-Q1"]);
  const due = await tool("getCivilDueReviews", { limit: 10 }, ctx);
  assert.deepEqual(due.reviews.map((row) => row.question_id), ["U1-Q1"]);
  await assert.rejects(() => tool("submitCivilRecall", {
    requestId: "r-unsafe", questionId: "U1-Q2", answerText: "사용자 답", memoryResult: "PARTIAL",
  }, ctx), /recall question content unavailable/);
  assert.equal(queries.filter((sql) => sql.includes("INSERT INTO recall_attempts")).length, 0);
  assert.ok(queries.some((sql) => sql.includes("ROLLBACK")));
});

test("unverified concept import remains maintenance-only", async () => {
  const mcp = await readFile(new URL("../app/mcp/route.js", import.meta.url), "utf8");
  const maintenance = await readFile(new URL("../app/api/maintenance/import-concept-sheet-questions/route.js", import.meta.url), "utf8");
  assert.doesNotMatch(mcp, /server\.registerTool\(\s*["']importCivilConceptQuestionTemplates["']/);
  assert.match(maintenance, /timingSafeEqual/);
  assert.match(maintenance, /MAINTENANCE_TOKEN/);
});
