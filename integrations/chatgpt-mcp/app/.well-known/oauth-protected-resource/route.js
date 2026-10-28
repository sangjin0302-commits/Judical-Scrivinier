import {
  metadataCorsOptionsRequestHandler,
  protectedResourceHandler,
} from "mcp-handler";

import { authConfig } from "../../../auth.mjs";

export const dynamic = "force-dynamic";

const config = authConfig();
const handler = protectedResourceHandler({
  authServerUrls: [config.issuer],
  resourceUrl: config.resource,
});
const optionsHandler = metadataCorsOptionsRequestHandler();

export { handler as GET, optionsHandler as OPTIONS };
