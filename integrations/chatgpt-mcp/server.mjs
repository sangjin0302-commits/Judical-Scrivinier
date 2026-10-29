import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { createPostgresExecutor } from "./db/postgres-adapter.mjs";

const TOOLS = [
  {
    name: "getCivilExamProgress",
    title: "민법 공식 문제 진행 현황",
    description: "인증된 본인의 1차·2차 문제별 풀이횟수, 최근 점수, 복습일, 2차 숙련·통과·졸업 상태를 읽기 전용으로 조회합니다. 이관 이력이 모호하면 미확인으로 표시합니다.",
    inputSchema: { type: "object", properties: {
      stage: { type: "string", enum: ["P1", "P2"] },
      cursor: { type: "string", maxLength: 300 },
      limit: { type: "integer", minimum: 1, maximum: 100 }
    }, additionalProperties: false }
  },
  {
    name: "issueCivilP1",
    title: "민법 1차 공식 문제 출제",
    description: "PostgreSQL 공식 OX를 기본 10문항, 요청 시 1~40문항 출제합니다. 범위·취약·안정키 지정 가능. 같은 requestId 재시도는 같은 세트를 반환합니다.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", minLength: 1, maxLength: 200 },
        count: { type: "integer", minimum: 1, maximum: 40 },
        mode: { type: "string", enum: ["전범위", "범위지정", "취약", "문제지정",
          "미풀이", "오답", "낮은점수", "복습대상", "원문변경"] },
        keyword: { type: "string", maxLength: 100 },
        questionType: { type: "string", maxLength: 100 },
        year: { type: "string", pattern: "^[0-9]{4}$" },
        session: { type: "string", pattern: "^[1-9][0-9]{0,2}$" },
        questionNumber: { type: "string", pattern: "^[1-9][0-9]{0,2}$" },
        lowScoreBelow: { type: "number", exclusiveMinimum: 0, maximum: 1 },
        specificKeys: { type: "array", minItems: 1, maxItems: 40,
          items: { type: "string", minLength: 1, maxLength: 250 } }
      },
      additionalProperties: false
    }
  },
  {
    name: "gradeCivilP1",
    title: "민법 1차 공식 답안 채점",
    description: "출제된 세트의 문항 수만큼 O/X 답안을 제출하고 공식 채점 결과를 기록합니다.",
    inputSchema: {
      type: "object",
      required: ["setId", "answers"],
      properties: {
        setId: { type: "string", minLength: 1, maxLength: 100 },
        answers: {
          type: "array",
          minItems: 1,
          maxItems: 40,
          items: { type: "string", enum: ["O", "X"] }
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "issueCivilP2",
    title: "민법 2차 공식 사례 출제",
    description: "PostgreSQL에서 공식 2차 사례를 선택하고 해당 사례의 모든 소문항을 함께 출제합니다.",
    inputSchema: { type: "object", required: ["requestId"], properties: {
      requestId: { type: "string", minLength: 1, maxLength: 200 },
      caseCount: { type: "integer", minimum: 1, maximum: 20 },
      mode: { type: "string", enum: ["전범위", "범위지정", "취약", "문제지정",
        "미풀이", "오답", "낮은점수", "복습대상", "원문변경"] },
      keyword: { type: "string", maxLength: 100 },
      questionType: { type: "string", maxLength: 100 },
      year: { type: "string", pattern: "^[0-9]{4}$" },
      session: { type: "string", pattern: "^[1-9][0-9]{0,2}$" },
      questionNumber: { type: "string", pattern: "^[1-9][0-9]{0,2}$" },
      lowScoreBelow: { type: "number", exclusiveMinimum: 0, maximum: 1 },
      specificKeys: { type: "array", minItems: 1, maxItems: 20,
        items: { type: "string", minLength: 1, maxLength: 250 } }
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
    description: "공식 모범답안 필수 의미요소 비율로 AI 학습평가 점수를 계산하고 7요소 진단과 별도 기록합니다.",
    inputSchema: { type: "object", required: ["setId", "evaluations"], properties: {
      setId: { type: "string", minLength: 1, maxLength: 100 }, evaluations: { type: "array", minItems: 1 }
    }, additionalProperties: false }
  }
];

function issueFilters(input) {
  const result = {};
  if (input.questionType !== undefined) {
    if (typeof input.questionType !== "string" || input.questionType.trim().length > 100) {
      throw new Error("questionType가 유효하지 않습니다.");
    }
    result.questionType = input.questionType.trim();
  }
  for (const [field, pattern] of [["year", /^[0-9]{4}$/],
    ["session", /^[1-9][0-9]{0,2}$/], ["questionNumber", /^[1-9][0-9]{0,2}$/]]) {
    if (input[field] === undefined) continue;
    const value = String(input[field]).trim();
    if (!pattern.test(value)) throw new Error(`${field}가 유효하지 않습니다.`);
    result[field] = value;
  }
  if (input.lowScoreBelow !== undefined) {
    const value = Number(input.lowScoreBelow);
    if (!Number.isFinite(value) || value <= 0 || value > 1) {
      throw new Error("lowScoreBelow가 유효하지 않습니다.");
    }
    result.lowScoreBelow = value;
  }
  if (input.mode === "낮은점수" && result.lowScoreBelow === undefined) {
    throw new Error("낮은점수 모드에는 lowScoreBelow가 필요합니다.");
  }
  return result;
}

export function validateToolInput(name, input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("입력은 객체여야 합니다.");
  if (name === "getCivilExamProgress") {
    const unknown = Object.keys(input).filter((key) => !["stage", "cursor", "limit"].includes(key));
    if (unknown.length) throw new Error(`허용되지 않은 입력: ${unknown.join(", ")}`);
    const { stage, cursor, limit } = input;
    if (stage !== undefined && !["P1", "P2"].includes(stage)) throw new Error("stage가 유효하지 않습니다.");
    if (cursor !== undefined && (typeof cursor !== "string" || cursor.length > 300)) throw new Error("cursor가 유효하지 않습니다.");
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) throw new Error("limit가 유효하지 않습니다.");
    return { ...(stage ? { stage } : {}), ...(cursor ? { cursor } : {}), ...(limit ? { limit } : {}) };
  }
  if (name === "issueCivilP1") {
    const unknown = Object.keys(input).filter((key) =>
      !["requestId", "count", "mode", "keyword", "specificKeys", "questionType",
        "year", "session", "questionNumber", "lowScoreBelow"].includes(key));
    if (unknown.length) throw new Error(`허용되지 않은 입력: ${unknown.join(", ")}`);
    const requestId = String(input.requestId || randomUUID()).trim();
    if (!requestId || requestId.length > 200) throw new Error("requestId가 유효하지 않습니다.");
    const mode = String(input.mode || "전범위").trim();
    const keyword = String(input.keyword || "").trim();
    const specificKeys = input.specificKeys;
    if (mode === "문제지정" && !Array.isArray(specificKeys)) {
      throw new Error("specificKeys가 유효하지 않습니다.");
    }
    const count = Number(input.count ?? (mode === "문제지정" ? specificKeys?.length : 10));
    if (!Number.isInteger(count) || count < 1 || count > 40) throw new Error("count가 유효하지 않습니다.");
    if (!["전범위", "범위지정", "취약", "문제지정", "미풀이", "오답", "낮은점수",
      "복습대상", "원문변경"].includes(mode)) throw new Error("mode가 유효하지 않습니다.");
    if (keyword.length > 100 || (mode === "범위지정" && !keyword)) throw new Error("keyword가 유효하지 않습니다.");
    if (mode === "문제지정" ? !Array.isArray(specificKeys) || specificKeys.length !== count : specificKeys !== undefined) {
      throw new Error("specificKeys가 유효하지 않습니다.");
    }
    if (specificKeys?.some((key) => typeof key !== "string" || !key.trim() || key.length > 250)) {
      throw new Error("specificKeys가 유효하지 않습니다.");
    }
    return { requestId, count, mode, keyword, ...(specificKeys ? { specificKeys } : {}),
      ...issueFilters(input) };
  }
  if (name === "gradeCivilP1") {
    const unknown = Object.keys(input).filter((key) => !["setId", "answers"].includes(key));
    if (unknown.length) throw new Error(`허용되지 않은 입력: ${unknown.join(", ")}`);
    const setId = String(input.setId || "").trim();
    if (!setId || setId.length > 100) throw new Error("setId가 유효하지 않습니다.");
    if (!Array.isArray(input.answers) || input.answers.length < 1 || input.answers.length > 40) {
      throw new Error("O/X 답안 1~40개가 필요합니다.");
    }
    const answers = input.answers.map((answer) => String(answer).trim().toUpperCase());
    if (answers.some((answer) => answer !== "O" && answer !== "X")) throw new Error("답안은 O 또는 X만 허용합니다.");
    return { setId, answers };
  }
  if (name === "issueCivilP2") {
    const unknown = Object.keys(input).filter((key) =>
      !["requestId", "caseCount", "mode", "keyword", "specificKeys", "questionType",
        "year", "session", "questionNumber", "lowScoreBelow"].includes(key));
    if (unknown.length) throw new Error(`허용되지 않은 입력: ${unknown.join(", ")}`);
    const requestId = String(input.requestId || "").trim();
    if (input.mode === "문제지정" && !Array.isArray(input.specificKeys)) {
      throw new Error("specificKeys가 유효하지 않습니다.");
    }
    const caseCount = Number(input.caseCount ?? (input.mode === "문제지정" ? input.specificKeys?.length : 1));
    const mode = String(input.mode || "전범위").trim();
    const keyword = String(input.keyword || "").trim();
    if (!requestId || requestId.length > 200) throw new Error("requestId가 유효하지 않습니다.");
    if (!Number.isInteger(caseCount) || caseCount < 1 || caseCount > 20) throw new Error("caseCount가 유효하지 않습니다.");
    if (!["전범위", "범위지정", "취약", "문제지정", "미풀이", "오답", "낮은점수",
      "복습대상", "원문변경"].includes(mode)) throw new Error("mode가 유효하지 않습니다.");
    if (keyword.length > 100 || (mode === "범위지정" && !keyword)) throw new Error("keyword가 유효하지 않습니다.");
    const specificKeys = input.specificKeys;
    if (mode === "문제지정" ? !Array.isArray(specificKeys) || specificKeys.length !== caseCount : specificKeys !== undefined) {
      throw new Error("specificKeys가 유효하지 않습니다.");
    }
    if (specificKeys?.some((key) => typeof key !== "string" || !key.trim() || key.length > 250)) {
      throw new Error("specificKeys가 유효하지 않습니다.");
    }
    return { requestId, caseCount, mode, keyword, ...(specificKeys ? { specificKeys } : {}),
      ...issueFilters(input) };
  }
  if (name === "prepareCivilP2Grade") {
    const unknown = Object.keys(input).filter((key) => !["setId", "answers"].includes(key));
    if (unknown.length) throw new Error(`허용되지 않은 입력: ${unknown.join(", ")}`);
    const setId = String(input.setId || "").trim();
    if (!setId || setId.length > 100 || !Array.isArray(input.answers) || !input.answers.length) throw new Error("setId/answers가 유효하지 않습니다.");
    const answers = input.answers.map((item) => ({ key: String(item?.key || "").trim(), text: item?.text }));
    if (answers.some((item) => !item.key || typeof item.text !== "string" ||
        !item.text.trim() || item.text.length > 50000)) throw new Error("실제 원답이 유효하지 않습니다.");
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
