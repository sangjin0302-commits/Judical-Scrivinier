import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";

import { authConfig, createWorkOSVerifier } from "../../auth.mjs";
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
      "issueCivilP1",
      {
        title: "민법 1차 공식 문제 출제",
        description:
          "독립 테스트 문제은행에서 공식 OX 10문항을 출제하고 세트를 기록합니다. 같은 requestId 재시도는 같은 세트를 반환합니다.",
        inputSchema: z.object({
          requestId: z.string().min(1).max(200),
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
          "출제된 세트의 O/X 답안 10개를 제출하고 공식 채점 결과와 학습이력을 기록합니다. 답안 제출 전에는 호출하지 않습니다.",
        inputSchema: z.object({
          setId: z.string().min(1).max(100),
          answers: z.array(z.enum(["O", "X"])).length(10),
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
      { title: "민법 2차 공식 사례 출제", description: "독립 테스트 문제은행에서 공식 2차 사례와 소문항을 출제합니다.",
        inputSchema: z.object({ requestId: z.string().min(1).max(200), caseCount: z.number().int().min(1).max(20).optional(),
          mode: z.enum(["전범위", "범위지정", "취약"]).optional(), keyword: z.string().max(200).optional() }),
        annotations: writeAnnotations, securitySchemes: oauthSecurity, _meta: { securitySchemes: oauthSecurity } },
      async (input, ctx) => callTool("issueCivilP2", input, {
        ownerId: ownerIdFromContext(ctx),
      }),
    );

    server.registerTool(
      "prepareCivilP2Grade",
      { title: "민법 2차 원답 제출 및 채점기준 조회",
        description: "사용자의 실제 원답 전체를 확정한 뒤에만 선택된 소문항의 공식 모범답안과 채점기준을 조회합니다.",
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
        description: "제출된 원답을 공식 모범답안 핵심요소와 의미 단위로 대조합니다. 근거 발췌문을 확인하고 핵심요소 일치율과 기존 7요소 배점 점수를 분리해 기록합니다.",
        inputSchema: z.object({ setId: z.string().min(1).max(100), evaluations: z.array(z.object({
          key: z.string().min(1).max(300), maxPoints: z.number().positive(), awardedPoints: z.number().nonnegative(),
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
function getHandler() {
  if (!handler) {
    const config = authConfig();
    handler = withMcpAuth(baseHandler, createWorkOSVerifier(), {
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

export function GET(request, context) { return getHandler()(request, context); }
export function POST(request, context) { return getHandler()(request, context); }
