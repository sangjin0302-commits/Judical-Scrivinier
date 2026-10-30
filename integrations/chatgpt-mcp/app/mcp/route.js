import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";

import { authConfig, authEnvForRequest, createWorkOSVerifier } from "../../auth.mjs";
import { callTool } from "../../server.mjs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const oauthSecurity = [{ type: "oauth2", scopes: String(process.env.WORKOS_REQUIRED_SCOPES || "openid")
  .split(/[ ,]+/).map((value) => value.trim()).filter(Boolean) }];
const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};
const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};
const ownerIdFromContext = (ctx) => ctx?.http?.authInfo?.extra?.userId;

const baseHandler = createMcpHandler(
  (server) => {
    server.registerTool(
      "getCivilExamProgress",
      {
        title: "민법 공식 문제 진행 현황",
        description: "본인의 문제별 풀이횟수·최근 점수·복습일과 2차 숙련·통과·졸업을 읽기 전용으로 조회합니다. 불확실한 이관 기록은 미확인으로 표시합니다.",
        inputSchema: z.object({
          stage: z.enum(["P1", "P2"]).optional(),
          cursor: z.string().max(300).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        }),
        annotations: readAnnotations,
        securitySchemes: oauthSecurity,
        _meta: { securitySchemes: oauthSecurity },
      },
      async (input, ctx) => callTool("getCivilExamProgress", input, {
        ownerId: ownerIdFromContext(ctx),
      }),
    );

    server.registerTool(
      "issueCivilP1",
      {
        title: "민법 1차 공식 문제 출제",
        description:
          "PostgreSQL 공식 OX를 기본 10문항, 요청 시 1~40문항 출제합니다. 범위·취약·안정키 지정 가능. 같은 requestId 재시도는 같은 세트를 반환합니다.",
        inputSchema: z.object({
          requestId: z.string().min(1).max(200),
          count: z.number().int().min(1).max(40).optional(),
          mode: z.enum(["전범위", "범위지정", "취약", "문제지정", "미풀이", "오답",
            "낮은점수", "복습대상", "원문변경"]).optional(),
          keyword: z.string().max(100).optional(),
          questionType: z.string().max(100).optional(),
          year: z.string().regex(/^[0-9]{4}$/).optional(),
          session: z.string().regex(/^[1-9][0-9]{0,2}$/).optional(),
          questionNumber: z.string().regex(/^[1-9][0-9]{0,2}$/).optional(),
          lowScoreBelow: z.number().positive().max(1).optional(),
          specificKeys: z.array(z.string().min(1).max(250)).min(1).max(40).optional(),
        }),
        annotations: writeAnnotations,
        securitySchemes: oauthSecurity,
        _meta: { securitySchemes: oauthSecurity },
      },
      async (input, ctx) => callTool("issueCivilP1", input, {
        ownerId: ownerIdFromContext(ctx),
      }),
    );

    server.registerTool(
      "gradeCivilP1",
      {
        title: "민법 1차 공식 답안 채점",
        description:
          "출제된 세트의 문항 수만큼 O/X 답안을 제출하고 채점 결과와 풀이이력을 기록합니다. 답안 제출 전에는 호출하지 않습니다.",
        inputSchema: z.object({
          setId: z.string().min(1).max(100),
          answers: z.array(z.enum(["O", "X"])).min(1).max(40),
        }),
        annotations: writeAnnotations,
        securitySchemes: oauthSecurity,
        _meta: { securitySchemes: oauthSecurity },
      },
      async (input, ctx) => callTool("gradeCivilP1", input, {
        ownerId: ownerIdFromContext(ctx),
      }),
    );

    server.registerTool(
      "issueCivilP2",
      { title: "민법 2차 공식 사례 출제", description: "PostgreSQL에서 사례를 선택하고 해당 사례의 모든 소문항을 함께 출제합니다.",
        inputSchema: z.object({ requestId: z.string().min(1).max(200), caseCount: z.number().int().min(1).max(20).optional(),
          mode: z.enum(["전범위", "범위지정", "취약", "문제지정", "미풀이", "오답",
            "낮은점수", "복습대상", "원문변경"]).optional(),
          keyword: z.string().max(100).optional(),
          questionType: z.string().max(100).optional(),
          year: z.string().regex(/^[0-9]{4}$/).optional(),
          session: z.string().regex(/^[1-9][0-9]{0,2}$/).optional(),
          questionNumber: z.string().regex(/^[1-9][0-9]{0,2}$/).optional(),
          lowScoreBelow: z.number().positive().max(1).optional(),
          specificKeys: z.array(z.string().min(1).max(250)).min(1).max(20).optional() }),
        annotations: writeAnnotations, securitySchemes: oauthSecurity, _meta: { securitySchemes: oauthSecurity } },
      async (input, ctx) => callTool("issueCivilP2", input, {
        ownerId: ownerIdFromContext(ctx),
      }),
    );

    server.registerTool(
      "prepareCivilP2Grade",
      { title: "민법 2차 원답 제출 및 채점기준 조회",
        description: "실제 작성한 소문항 원답을 변경 없이 확정한 뒤 공식 모범답안과 채점기준을 조회합니다. 빠진 소문항은 미제출로 구분하며 답안을 만들지 않습니다.",
        inputSchema: z.object({ setId: z.string().min(1).max(100), answers: z.array(z.object({
          key: z.string().min(1).max(300), text: z.string().min(1).max(50000) })).min(1) }),
        annotations: writeAnnotations, securitySchemes: oauthSecurity, _meta: { securitySchemes: oauthSecurity } },
      async (input, ctx) => callTool("prepareCivilP2Grade", input, {
        ownerId: ownerIdFromContext(ctx),
      }),
    );

    server.registerTool(
      "commitCivilP2Grade",
      { title: "민법 2차 AI 학습평가 기록 확정",
        description: "원답 확정 뒤 공식 모범답안의 중복 없는 필수 의미요소와 대조합니다. 완전 1·부분 0.5·누락/오류 0 비율에 최대 배점을 곱한 AI 학습평가 점수를 서버에서 계산합니다. 7요소는 별도 진단이며 공식 채점자 점수가 아닙니다.",
        inputSchema: z.object({ setId: z.string().min(1).max(100), evaluations: z.array(z.object({
          key: z.string().min(1).max(300), maxPoints: z.number().positive(),
          awardedPoints: z.number().nonnegative().optional(),
          scores: z.object({ issue: z.number().int().min(0).max(2), outline: z.number().int().min(0).max(2),
            law: z.number().int().min(0).max(2), precedent: z.number().int().min(0).max(2),
            application: z.number().int().min(0).max(2), conclusion: z.number().int().min(0).max(2),
            expression: z.number().int().min(0).max(2) }), correction: z.string().max(10000).optional(),
          errorType: z.string().min(1).max(1000), checkType: z.string().min(1).max(1000),
          missingOutline: z.string().max(10000).optional(),
          wrongLaw: z.string().max(10000).optional(), applicationFix: z.string().max(10000).optional(),
          modelDifference: z.string().max(10000).optional(), nextReview: z.string().min(1).max(1000),
          semanticAnalysis: z.object({
            elements: z.array(z.object({
              category: z.enum(["ISSUE", "LAW", "ELEMENT", "PRECEDENT", "APPLICATION", "CONCLUSION"]),
              criterion: z.string().min(1).max(500),
              status: z.enum(["MATCH", "PARTIAL", "MISSING", "ERROR", "ALTERNATIVE_ACCEPTED"]),
              modelExcerpt: z.string().min(1).max(2000), answerExcerpt: z.string().max(2000).optional(),
              explanation: z.string().min(1).max(2000), alternativeSourceRef: z.string().max(500).optional(),
            })).min(1).max(30),
            matchedLaw: z.array(z.string().min(1).max(1000)).max(30),
            missingLaw: z.array(z.string().min(1).max(1000)).max(30),
            misappliedLaw: z.array(z.string().min(1).max(1000)).max(30),
            improvement: z.string().min(1).max(5000),
            decompositionRationale: z.string().min(1).max(5000),
            scoreRationale: z.string().min(1).max(5000),
          })
        })).min(1) }), annotations: writeAnnotations, securitySchemes: oauthSecurity,
        _meta: { securitySchemes: oauthSecurity } },
      async (input, ctx) => callTool("commitCivilP2Grade", input, {
        ownerId: ownerIdFromContext(ctx),
      }),
    );

  },
  {
    serverInfo: { name: "civil-p1-chatgpt-mcp", version: "0.2.0" },
  },
);

let handler;
function getHandler(request) {
  if (!handler) {
    const env = authEnvForRequest(request.url);
    const config = authConfig(env);
    handler = withMcpAuth(baseHandler, createWorkOSVerifier(env), {
      required: true,
      requiredScopes: config.requiredScopes,
      resourceMetadataPath: "/.well-known/oauth-protected-resource",
      // mcp-handler appends resourceMetadataPath to this value. Passing the
      // complete /mcp resource URL would advertise a non-existent endpoint.
      resourceUrl: new URL(config.resource).origin,
    });
  }
  return handler;
}

export function GET(request, context) { return getHandler(request)(request, context); }
export function POST(request, context) { return getHandler(request)(request, context); }
