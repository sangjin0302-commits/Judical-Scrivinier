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
          requestId: z.string().min(1).max(200).optional(),
        }),
        annotations: writeAnnotations,
        securitySchemes: oauthSecurity,
        _meta: { securitySchemes: oauthSecurity },
      },
      async (input) => callTool("issueCivilP1", input),
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
      async (input) => callTool("gradeCivilP1", input),
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
