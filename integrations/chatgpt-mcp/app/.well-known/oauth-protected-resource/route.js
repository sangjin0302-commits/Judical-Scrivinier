import {
  metadataCorsOptionsRequestHandler,
  protectedResourceHandler,
} from "mcp-handler";

import { authConfig, authEnvForRequest } from "../../../auth.mjs";

export const dynamic = "force-dynamic";

const optionsHandler = metadataCorsOptionsRequestHandler();

export function GET(request) {
  const config = authConfig(authEnvForRequest(request.url));
  return protectedResourceHandler({
    authServerUrls: [config.issuer],
    resourceUrl: config.resource,
  })(request);
}

export { optionsHandler as OPTIONS };
