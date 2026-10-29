import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { createPostgresExecutor } from "./db/postgres-adapter.mjs";

const TOOLS = [
  {
    name: "issueCivilP1",
    title: "민법 1차 공식 문제 출제",
    description: "독립 테스트 문제은행에서 공식 OX 10문항을 출제합니다. 같은 requestId 재시도는 같은 세트를 반환합니다.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", minLength: 1, maxLength: 200 }
      },
      additionalProperties: false
    }
  },
  {
    name: "gradeCivilP1",
    title: "민법 1차 공식 답안 채점",
    description: "출제된 세트의 O/X 답안 10개를 제출하고 공식 채점 결과를 기록합니다.",
    inputSchema: {
      type: "object",
      required: ["setId", "answers"],
      properties: {
        setId: { type: "string", minLength: 1, maxLength: 100 },
        answers: {
          type: "array",
          minItems: 10,
          maxItems: 10,
          items: { type: "string", enum: ["O", "X"] }
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "issueCivilP2",
    title: "민법 2차 공식 사례 출제",
    description: "독립 테스트 문제은행에서 공식 2차 사례와 소문항을 출제합니다.",
    inputSchema: { type: "object", required: ["requestId"], properties: {
      requestId: { type: "string", minLength: 1, maxLength: 200 },
      caseCount: { type: "integer", minimum: 1, maximum: 20 },
      mode: { type: "string", enum: ["전범위", "범위지정", "취약"] },
      keyword: { type: "string", maxLength: 200 }
    }, additionalProperties: false }
  },
  {
    name: "prepareCivilP2Grade",
    title: "민법 2차 원답 제출 및 채점기준 조회",
    description: "실제 원답 전체를 확정한 뒤에만 해당 소문항의 비공개 채점기준을 조회합니다.",
    inputSchema: { type: "object", required: ["setId", "answers"], properties: {
      setId: { type: "string", minLength: 1, maxLength: 100 },
      answers: { type: "array", minItems: 1, items: { type: "object", required: ["key", "text"],
        properties: { key: { type: "string" }, text: { type: "string", minLength: 1, maxLength: 50000 } },
        additionalProperties: false } }
    }, additionalProperties: false }
  },
  {
    name: "commitCivilP2Grade",
    title: "민법 2차 AI 학습평가 기록 확정",
    description: "공식 모범답안 핵심요소와 원답의 의미 비교 근거를 검증하고 기존 7요소 점수와 별도 기록합니다.",
    inputSchema: { type: "object", required: ["setId", "evaluations"], properties: {
      setId: { type: "string", minLength: 1, maxLength: 100 }, evaluations: { type: "array", minItems: 1 }
    }, additionalProperties: false }
  }
];

export function validateToolInput(name, input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("입력은 객체여야 합니다.");
  if (name === "issueCivilP1") {
    const unknown = Object.keys(input).filter((key) => key !== "requestId");
    if (unknown.length) throw new Error(`허용되지 않은 입력: ${unknown.join(", ")}`);
    const requestId = String(input.requestId || randomUUID()).trim();
    if (!requestId || requestId.length > 200) throw new Error("requestId가 유효하지 않습니다.");
    return { requestId };
  }
  if (name === "gradeCivilP1") {
    const unknown = Object.keys(input).filter((key) => !["setId", "answers"].includes(key));
    if (unknown.length) throw new Error(`허용되지 않은 입력: ${unknown.join(", ")}`);
    const setId = String(input.setId || "").trim();
    if (!setId || setId.length > 100) throw new Error("setId가 유효하지 않습니다.");
    if (!Array.isArray(input.answers) || input.answers.length !== 10) throw new Error("O/X 답안 10개가 필요합니다.");
    const answers = input.answers.map((answer) => String(answer).trim().toUpperCase());
    if (answers.some((answer) => answer !== "O" && answer !== "X")) throw new Error("답안은 O 또는 X만 허용합니다.");
    return { setId, answers };
  }
  if (name === "issueCivilP2") {
    const unknown = Object.keys(input).filter((key) => !["requestId", "caseCount", "mode", "keyword"].includes(key));
    if (unknown.length) throw new Error(`허용되지 않은 입력: ${unknown.join(", ")}`);
    const requestId = String(input.requestId || "").trim();
    const caseCount = input.caseCount === undefined ? 1 : Number(input.caseCount);
    const mode = String(input.mode || "전범위").trim();
    const keyword = String(input.keyword || "").trim();
    if (!requestId || requestId.length > 200) throw new Error("requestId가 유효하지 않습니다.");
    if (!Number.isInteger(caseCount) || caseCount < 1 || caseCount > 20) throw new Error("caseCount가 유효하지 않습니다.");
    if (!["전범위", "범위지정", "취약"].includes(mode)) throw new Error("mode가 유효하지 않습니다.");
    if (keyword.length > 200 || (mode === "범위지정" && !keyword)) throw new Error("keyword가 유효하지 않습니다.");
    return { requestId, caseCount, mode, keyword };
  }
  if (name === "prepareCivilP2Grade") {
    const unknown = Object.keys(input).filter((key) => !["setId", "answers"].includes(key));
    if (unknown.length) throw new Error(`허용되지 않은 입력: ${unknown.join(", ")}`);
    const setId = String(input.setId || "").trim();
    if (!setId || setId.length > 100 || !Array.isArray(input.answers) || !input.answers.length) throw new Error("setId/answers가 유효하지 않습니다.");
    const answers = input.answers.map((item) => ({ key: String(item?.key || "").trim(), text: String(item?.text || "").trim() }));
    if (answers.some((item) => !item.key || !item.text || item.text.length > 50000)) throw new Error("실제 원답이 유효하지 않습니다.");
    return { setId, answers };
  }
  if (name === "commitCivilP2Grade") {
    const unknown = Object.keys(input).filter((key) => !["setId", "evaluations"].includes(key));
    if (unknown.length) throw new Error(`허용되지 않은 입력: ${unknown.join(", ")}`);
    const setId = String(input.setId || "").trim();
    if (!setId || setId.length > 100 || !Array.isArray(input.evaluations) || !input.evaluations.length) throw new Error("setId/evaluations가 유효하지 않습니다.");
    if (input.evaluations.some((evaluation) => !evaluation?.semanticAnalysis)) {
      throw new Error("핵심요소 비교 근거가 필요합니다.");
    }
    return { setId, evaluations: input.evaluations };
  }
  throw new Error(`지원하지 않는 도구: ${name}`);
}

let postgresExecutor;

async function executeConfigured(name, payload, context = {}) {
  if (process.env.MCP_DATA_BACKEND !== "postgres") {
    throw new Error("MCP_DATA_BACKEND must be postgres");
  }
  postgresExecutor ||= createPostgresExecutor();
  return postgresExecutor(name, payload, context);
}

export async function callTool(name, input, options = {}) {
  const payload = validateToolInput(name, input);
  let result;
  const executor = options.executor || executeConfigured;
  result = await executor(name, payload, { ownerId: options.ownerId });
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
    isError: false
  };
}

export async function handleRequest(message, executor = executeConfigured) {
  if (message?.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "civil-p1-chatgpt-mcp", version: "0.1.0" }
      }
    };
  }
  if (message?.method === "tools/list") {
    return { jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } };
  }
  if (message?.method === "tools/call") {
    try {
      const result = await callTool(message.params?.name, message.params?.arguments || {}, { executor });
      return { jsonrpc: "2.0", id: message.id, result };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: error.message }], isError: true }
      };
    }
  }
  if (message?.id === undefined) return null;
  return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let response;
    try {
      response = await handleRequest(JSON.parse(line));
    } catch (error) {
      response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: error.message } };
    }
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}
