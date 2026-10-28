import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";

import { authConfig, createWorkOSVerifier } from "../../auth.mjs";
import { callTool } from "../../server.mjs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const config = authConfig();
const oauthSecurity = [{ type: "oauth2", scopes: config.requiredScopes }];
const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};

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
      async (input, extra) => callTool("issueCivilP1", input, {
        ownerId: extra?.authInfo?.extra?.userId,
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
      async (input, extra) => callTool("gradeCivilP1", input, {
        ownerId: extra?.authInfo?.extra?.userId,
      }),
    );

    server.registerTool(
      "issueCivilP2",
      { title: "민법 2차 공식 사례 출제", description: "독립 테스트 문제은행에서 공식 2차 사례와 소문항을 출제합니다.",
        inputSchema: z.object({ requestId: z.string().min(1).max(200), caseCount: z.number().int().min(1).max(20).optional(),
          mode: z.enum(["전범위", "범위지정", "취약"]).optional(), keyword: z.string().max(200).optional() }),
        annotations: writeAnnotations, securitySchemes: oauthSecurity, _meta: { securitySchemes: oauthSecurity } },
      async (input, extra) => callTool("issueCivilP2", input, {
        ownerId: extra?.authInfo?.extra?.userId,
      }),
    );

    server.registerTool(
      "prepareCivilP2Grade",
      { title: "민법 2차 원답 제출 및 채점기준 조회",
        description: "사용자의 실제 원답 전체를 확정한 뒤에만 선택된 소문항의 채점기준을 조회합니다.",
        inputSchema: z.object({ setId: z.string().min(1).max(100), answers: z.array(z.object({
          key: z.string().min(1).max(300), text: z.string().min(1).max(50000) })).min(1) }),
        annotations: writeAnnotations, securitySchemes: oauthSecurity, _meta: { securitySchemes: oauthSecurity } },
      async (input, extra) => callTool("prepareCivilP2Grade", input, {
        ownerId: extra?.authInfo?.extra?.userId,
      }),
    );

    server.registerTool(
      "commitCivilP2Grade",
      { title: "민법 2차 AI 학습평가 기록 확정",
        description: "7요소 AI 학습평가와 점수·보완사항을 기록하고 검증한 뒤 제출 완료로 표시합니다.",
        inputSchema: z.object({ setId: z.string().min(1).max(100), evaluations: z.array(z.object({
          key: z.string().min(1).max(300), maxPoints: z.number().positive(), awardedPoints: z.number().nonnegative(),
          scores: z.object({ issue: z.number().int().min(0).max(2), outline: z.number().int().min(0).max(2),
            law: z.number().int().min(0).max(2), precedent: z.number().int().min(0).max(2),
            application: z.number().int().min(0).max(2), conclusion: z.number().int().min(0).max(2),
            expression: z.number().int().min(0).max(2) }), correction: z.string().max(10000).optional(),
          errorType: z.string().min(1).max(1000), checkType: z.string().min(1).max(1000),
          missingOutline: z.string().max(10000).optional(),
          wrongLaw: z.string().max(10000).optional(), applicationFix: z.string().max(10000).optional(),
          modelDifference: z.string().max(10000).optional(), nextReview: z.string().min(1).max(1000)
        })).min(1) }), annotations: writeAnnotations, securitySchemes: oauthSecurity,
        _meta: { securitySchemes: oauthSecurity } },
      async (input, extra) => callTool("commitCivilP2Grade", input, {
        ownerId: extra?.authInfo?.extra?.userId,
      }),
    );
  },
  {
    serverInfo: { name: "civil-p1-chatgpt-mcp", version: "0.2.0" },
  },
);

const handler = withMcpAuth(baseHandler, createWorkOSVerifier(), {
  required: true,
  requiredScopes: config.requiredScopes,
  resourceMetadataPath: "/.well-known/oauth-protected-resource",
  // mcp-handler appends resourceMetadataPath to this value.  Passing the
  // complete /mcp resource URL would advertise the non-existent
  // /mcp/.well-known/... endpoint and break OAuth discovery in ChatGPT.
  resourceUrl: new URL(config.resource).origin,
});

export { handler as GET, handler as POST };
