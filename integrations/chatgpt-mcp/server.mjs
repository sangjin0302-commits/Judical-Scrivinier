import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

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
    description: "7요소 평가와 점수·보완사항을 기록하고 검증한 뒤 제출 완료로 표시합니다.",
    inputSchema: { type: "object", required: ["setId", "evaluations"], properties: {
      setId: { type: "string", minLength: 1, maxLength: 100 }, evaluations: { type: "array", minItems: 1 }
    }, additionalProperties: false }
  }
];

function requiredEnv(name, env = process.env) {
  const value = String(env[name] || "").trim();
  if (!value) throw new Error(`필수 환경변수 누락: ${name}`);
  return value;
}

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
    return { setId, evaluations: input.evaluations };
  }
  throw new Error(`지원하지 않는 도구: ${name}`);
}

async function oauthSecrets(env) {
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN) {
    return {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      refreshToken: env.GOOGLE_REFRESH_TOKEN
    };
  }
  const clientFile = resolve(env.GOOGLE_OAUTH_CLIENT_FILE || "private/oauth/google-desktop-client.json");
  const tokenFile = resolve(env.GOOGLE_OAUTH_TOKEN_FILE || "private/oauth/google-user-token.json");
  const clientJson = JSON.parse(await readFile(clientFile, "utf8"));
  const tokenJson = JSON.parse(await readFile(tokenFile, "utf8"));
  const client = clientJson.installed || clientJson.web;
  if (!client?.client_id || !client?.client_secret || !tokenJson.refresh_token) {
    throw new Error("로컬 Google OAuth 자격증명이 완전하지 않습니다.");
  }
  return { clientId: client.client_id, clientSecret: client.client_secret, refreshToken: tokenJson.refresh_token };
}

async function googleAccessToken(env = process.env, fetchImpl = fetch) {
  const secrets = await oauthSecrets(env);
  const body = new URLSearchParams({
    client_id: secrets.clientId,
    client_secret: secrets.clientSecret,
    refresh_token: secrets.refreshToken,
    grant_type: "refresh_token"
  });
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error(`Google OAuth 갱신 실패 (${response.status})`);
  return data.access_token;
}

export async function executeAppsScript(functionName, parameters, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const deploymentId = requiredEnv("GOOGLE_SCRIPT_DEPLOYMENT_ID", env);
  const accessToken = await googleAccessToken(env, fetchImpl);
  const response = await fetchImpl(`https://script.googleapis.com/v1/scripts/${encodeURIComponent(deploymentId)}:run`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ function: functionName, parameters, devMode: false })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Apps Script 호출 실패 (${response.status}): ${data?.error?.message || "권한 또는 배포 설정 확인 필요"}`);
  if (data.error) throw new Error(`Apps Script 실행 실패: ${data.error.message || "알 수 없는 오류"}`);
  const result = data?.response?.result;
  if (!result || result.ok !== true) throw new Error("Apps Script가 정상 결과를 반환하지 않았습니다.");
  return result;
}

export async function callTool(name, input, executor = executeAppsScript) {
  const payload = validateToolInput(name, input);
  const functions = {
    issueCivilP1: "PB1F_issue", gradeCivilP1: "PB1F_grade", issueCivilP2: "P2F_issue",
    prepareCivilP2Grade: "P2F_prepareGrade", commitCivilP2Grade: "P2F_commitGrade"
  };
  const functionName = functions[name];
  const result = await executor(functionName, [payload]);
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
    isError: false
  };
}

export async function handleRequest(message, executor = executeAppsScript) {
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
      const result = await callTool(message.params?.name, message.params?.arguments || {}, executor);
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
