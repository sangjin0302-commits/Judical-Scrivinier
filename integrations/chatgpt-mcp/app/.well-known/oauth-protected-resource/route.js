import {
  metadataCorsOptionsRequestHandler,
  protectedResourceHandler,
} from "mcp-handler";

import { authConfig } from "../../../auth.mjs";

export const dynamic = "force-dynamic";

const optionsHandler = metadataCorsOptionsRequestHandler();

export function GET(request) {
  const config = authConfig();
  return protectedResourceHandler({
    authServerUrls: [config.issuer],
    resourceUrl: config.resource,
  })(request);
}

export { optionsHandler as OPTIONS };
