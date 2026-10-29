import assert from "node:assert/strict";
import test from "node:test";
import { callTool, handleRequest, validateToolInput } from "../server.mjs";

test("five official exam write tools and progress read tool appear in stdio catalog", async () => {
  const response = await handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(response.result.tools.map((tool) => tool.name), [
    "getCivilExamProgress", "issueCivilP1", "gradeCivilP1", "issueCivilP2", "prepareCivilP2Grade", "commitCivilP2Grade",
  ]);
});

test("progress input is bounded and owner comes from authenticated context", async () => {
  assert.deepEqual(validateToolInput("getCivilExamProgress", { stage: "P2", limit: 20 }),
    { stage: "P2", limit: 20 });
  assert.throws(() => validateToolInput("getCivilExamProgress", { ownerId: "forged" }), /허용되지 않은 입력/);
  assert.throws(() => validateToolInput("getCivilExamProgress", { limit: 101 }), /limit/);
  let call;
  await callTool("getCivilExamProgress", { stage: "P1" }, {
    ownerId: "workos_owner", executor: async (...args) => { call = args; return { items: [] }; },
  });
  assert.deepEqual(call, ["getCivilExamProgress", { stage: "P1" }, { ownerId: "workos_owner" }]);
});

test("retired concept tools fail closed", () => {
  for (const name of ["getCivilConceptUnit", "setCivilStudyMode", "getCivilDueReviews",
    "submitCivilRecall", "recordCivilStudyActivity", "importCivilConceptQuestionTemplates"]) {
    assert.throws(() => validateToolInput(name, {}), /지원하지 않는 도구/);
  }
});

test("P1 input accepts issued O/X count within 1–40", () => {
  const valid = validateToolInput("gradeCivilP1", { setId: "P1-1",
    answers: ["o", "x", "O", "X", "O", "X", "O", "X", "O", "X"] });
  assert.deepEqual(valid.answers, ["O", "X", "O", "X", "O", "X", "O", "X", "O", "X"]);
  assert.deepEqual(validateToolInput("gradeCivilP1", { setId: "P1-1", answers: ["O"] }).answers, ["O"]);
  assert.throws(() => validateToolInput("gradeCivilP1", { setId: "P1-1", answers: [] }), /1~40개/);
  assert.throws(() => validateToolInput("gradeCivilP1", { setId: "P1-1", answers: Array(41).fill("O") }), /1~40개/);
});

test("issue controls accept range, count, exact problem, and weak mode", () => {
  assert.deepEqual(validateToolInput("issueCivilP1", { requestId: "p1-range", count: 7,
    mode: "범위지정", keyword: "물권" }),
  { requestId: "p1-range", count: 7, mode: "범위지정", keyword: "물권" });
  assert.deepEqual(validateToolInput("issueCivilP1", { requestId: "p1-specific",
    mode: "문제지정", specificKeys: ["key-1"] }).count, 1);
  assert.deepEqual(validateToolInput("issueCivilP2", { requestId: "p2-specific",
    mode: "문제지정", specificKeys: ["group-1"] }).caseCount, 1);
  assert.equal(validateToolInput("issueCivilP2", { requestId: "p2-weak", mode: "취약" }).mode, "취약");
  assert.throws(() => validateToolInput("issueCivilP1", { requestId: "bad", mode: "문제지정" }), /specificKeys/);
});

test("P2 submission rejects empty original answer", () => {
  assert.throws(() => validateToolInput("prepareCivilP2Grade", {
    setId: "P2-1", answers: [{ key: "k1", text: "" }],
  }), /원답/);
});

test("PostgreSQL executor receives canonical name and authenticated owner", async () => {
  let called;
  const result = await callTool("issueCivilP1", { requestId: "db-r1" }, {
    ownerId: "user_workos_1",
    executor: async (...args) => {
      called = args;
      return { ok: true, setId: "P1-db", count: 10, questions: [] };
    },
  });
  assert.deepEqual(called, ["issueCivilP1", { requestId: "db-r1", count: 10,
    mode: "전범위", keyword: "" }, { ownerId: "user_workos_1" }]);
  assert.equal(result.structuredContent.setId, "P1-db");
});

test("runtime has no Apps Script fallback", async () => {
  const previous = process.env.MCP_DATA_BACKEND;
  delete process.env.MCP_DATA_BACKEND;
  try {
    const response = await handleRequest({ jsonrpc: "2.0", id: 7, method: "tools/call",
      params: { name: "issueCivilP1", arguments: { requestId: "fail-closed" } } });
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /MCP_DATA_BACKEND must be postgres/);
  } finally {
    if (previous === undefined) delete process.env.MCP_DATA_BACKEND;
    else process.env.MCP_DATA_BACKEND = previous;
  }
});
