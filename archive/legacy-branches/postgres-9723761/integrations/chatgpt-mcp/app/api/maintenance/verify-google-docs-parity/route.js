import crypto from "node:crypto";
import { verifyGoogleDocsParity } from "../../../../db/verify-google-docs-parity-readonly.mjs";

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
    return Response.json(await verifyGoogleDocsParity());
  } catch (error) {
    console.error("Google Docs parity verification failed", { name: error?.name, message: error?.message });
    return Response.json({ ok: false, error: "verification failed" }, { status: 500 });
  }
}
