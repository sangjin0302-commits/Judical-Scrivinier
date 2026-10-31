import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { fetchConceptQuestionRows, importConceptQuestionRows, parseConceptQuestionRows } from "../db/import-concept-sheet-questions.mjs";
import { POST as importRoute } from "../app/api/maintenance/import-concept-sheet-questions/route.js";

test("concept import route rejects unauthenticated requests before source access", async () => {
  const response = await importRoute(new Request("https://example.invalid/api/maintenance/import-concept-sheet-questions", { method: "POST" }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, error: "unauthorized" });
});

const header = ["질문ID", "단원ID", "권", "원문 페이지", "회상 단계", "질문 (정답 없음)",
  "연계 문제 안정키", "생성 근거", "질문 검증·운영 규칙"];
const rows = () => [header, ...Array.from({ length: 240 }, (_, index) => {
  const unitId = `B1-P${String(index).padStart(4, "0")}`;
  return [1, 2, 3].map((order) => [`${unitId}-Q${order}`, unitId, "1권", "1~2쪽", "목차 회상",
    `원본 템플릿 질문 ${index} ${order}`, "", "단원 범위 기반", "검증 전"]);
}).flat()];

test("concept Sheet rows require exact 240/720 stable IDs and nonempty prompts", () => {
  const parsed = parseConceptQuestionRows(rows());
  assert.equal(parsed.questions.length, 720);
  assert.equal(parsed.questions[0].questionOrder, 1);
  assert.equal(new Set(parsed.questions.map((item) => item.unitId)).size, 240);
  const duplicate = rows(); duplicate[2][0] = duplicate[1][0];
  assert.throws(() => parseConceptQuestionRows(duplicate), /duplicate question ID/);
  const missing = rows(); missing[2][5] = "";
  assert.throws(() => parseConceptQuestionRows(missing), /promptText is required/);
});

test("concept Sheet reader uses only fixed read range and keeps OAuth token out of URL", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.includes("oauth2.googleapis.com")) return { ok: true, json: async () => ({ access_token: "fixture-token" }) };
    return { ok: true, json: async () => ({ values: rows() }) };
  };
  const parsed = await fetchConceptQuestionRows({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_REFRESH_TOKEN: "refresh" }, fetchImpl);
  assert.equal(parsed.questions.length, 720);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.method, "GET");
  assert.match(requests[1].url, /A4%3AI724/);
  assert.doesNotMatch(requests[1].url, /fixture-token|refresh|secret/);
});

test("import preserves source-mapped questions and updates only empty indexed rows", async () => {
  const parsed = parseConceptQuestionRows(rows());
  const original = parsed.questions.map((item, index) => ({ question_id: item.questionId,
    unit_id: item.unitId, question_order: item.questionOrder,
    content_state: index < 21 ? "source-mapped" : "indexed-unavailable",
    content_digest: index < 21 ? "source-digest" : "index-digest",
    prompt_text: index < 21 ? "검증된 기존 질문" : null }));
  const seen = [];
  const client = { query: async (sql, params) => {
    seen.push({ sql, params });
    if (sql.includes("FROM recall_questions WHERE")) return { rowCount: 720, rows: original };
    if (sql.includes("UPDATE recall_questions q")) return { rowCount: 699 };
    return { rowCount: 0, rows: [] };
  } };
  const result = await importConceptQuestionRows(client, parsed);
  assert.deepEqual({ imported: result.imported, preserved: result.preservedSourceMapped },
    { imported: 699, preserved: 21 });
  const update = seen.find((item) => item.sql.includes("UPDATE recall_questions q"));
  assert.match(update.sql, /q\.content_state='indexed-unavailable'/);
  assert.match(update.sql, /q\.prompt_text IS NULL/);
  assert.equal(seen.at(-1).sql, "COMMIT");
});

test("0005 migration adds explicit unverified template state and append-only import ledger", async () => {
  const migration = await readFile(new URL("../db/migrations/0005_concept_sheet_questions.sql", import.meta.url), "utf8");
  assert.match(migration, /template-unverified/);
  assert.match(migration, /concept_question_imports/);
  assert.match(migration, /reject_committed_record_change/);
});
