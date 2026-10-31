import crypto from "node:crypto";
import { detectAllGoogleDocs } from "../../../../db/detect-google-docs-sync.mjs";

export const maxDuration = 300;

function authorized(request) {
  const expected = Buffer.from(process.env.MAINTENANCE_TOKEN || "");
  const received = Buffer.from(request.headers.get("x-maintenance-token") || "");
  return expected.length >= 32 && expected.length === received.length &&
    crypto.timingSafeEqual(expected, received);
}

export async function POST(request) {
  if (!authorized(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    return Response.json(await detectAllGoogleDocs());
  } catch {
    return Response.json({ ok: false, error: "detection failed" }, { status: 500 });
  }
}
