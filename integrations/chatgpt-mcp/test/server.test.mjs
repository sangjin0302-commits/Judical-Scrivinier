import test from "node:test";
import assert from "node:assert/strict";
import { callTool, executeAppsScript, handleRequest, validateToolInput } from "../server.mjs";

test("issueCivilP1 maps only to PB1F_issue and preserves request id", async () => {
  let called;
  const result = await callTool("issueCivilP1", { requestId: "retry-1" }, async (...args) => {
    called = args;
    return { ok: true, setId: "P1-1", count: 10, questions: [] };
  });
  assert.deepEqual(called, ["PB1F_issue", [{ requestId: "retry-1" }]]);
  assert.equal(result.structuredContent.setId, "P1-1");
});

test("gradeCivilP1 requires exactly ten normalized O/X answers", () => {
  const valid = validateToolInput("gradeCivilP1", {
    setId: "P1-1",
    answers: ["o", "x", "O", "X", "O", "X", "O", "X", "O", "X"]
  });
  assert.deepEqual(valid.answers, ["O", "X", "O", "X", "O", "X", "O", "X", "O", "X"]);
  assert.throws(() => validateToolInput("gradeCivilP1", { setId: "P1-1", answers: ["O"] }), /10개/);
});

test("tool errors stay in MCP result and do not leak credentials", async () => {
  const response = await handleRequest({
    jsonrpc: "2.0", id: 7, method: "tools/call",
    params: { name: "gradeCivilP1", arguments: { setId: "P1-1", answers: [] } }
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /10개/);
});

test("Apps Script adapter refreshes OAuth and invokes only configured deployment", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (url.includes("oauth2.googleapis.com")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "access-token" }) };
    }
    return {
      ok: true, status: 200,
      json: async () => ({ response: { result: { ok: true, setId: "P1-1" } } })
    };
  };
  const env = {
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    GOOGLE_REFRESH_TOKEN: "refresh-token",
    GOOGLE_SCRIPT_DEPLOYMENT_ID: "deployment-id"
  };
  const result = await executeAppsScript("PB1F_issue", [{ requestId: "r1" }], { env, fetchImpl });
  assert.equal(result.setId, "P1-1");
  assert.equal(requests.length, 2);
  assert.match(requests[1].url, /deployment-id:run$/);
  assert.equal(requests[1].init.headers.authorization, "Bearer access-token");
  assert.doesNotMatch(JSON.stringify(requests[1]), /refresh-token|client-secret/);
});

test("P2 tools map to the three-stage Apps Script contract", async () => {
  const calls = [];
  const executor = async (...args) => { calls.push(args); return { ok: true }; };
  await callTool("issueCivilP2", { requestId: "p2-r1", caseCount: 1 }, executor);
  await callTool("prepareCivilP2Grade", { setId: "P2-1", answers: [{ key: "k1", text: "원답" }] }, executor);
  await callTool("commitCivilP2Grade", { setId: "P2-1", evaluations: [{ key: "k1" }] }, executor);
  assert.deepEqual(calls.map((call) => call[0]), ["P2F_issue", "P2F_prepareGrade", "P2F_commitGrade"]);
});

test("P2 answer submission rejects empty text before Apps Script", () => {
  assert.throws(() => validateToolInput("prepareCivilP2Grade", {
    setId: "P2-1", answers: [{ key: "k1", text: "" }]
  }), /원답/);
});

test("server exposes the approved P1 and staged P2 tools", async () => {
  const response = await handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(response.result.tools.map((tool) => tool.name), [
    "issueCivilP1", "gradeCivilP1", "issueCivilP2", "prepareCivilP2Grade", "commitCivilP2Grade"
  ]);
});
