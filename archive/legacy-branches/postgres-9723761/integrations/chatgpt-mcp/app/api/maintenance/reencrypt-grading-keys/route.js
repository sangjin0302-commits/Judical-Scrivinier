import crypto from "node:crypto";
import { reencryptGradingKeys } from "../../../../db/reencrypt-grading-keys.mjs";

export const maxDuration = 300;

function authorized(request) {
  const expected = Buffer.from(process.env.MAINTENANCE_TOKEN || "");
  const received = Buffer.from(request.headers.get("x-maintenance-token") || "");
  return expected.length >= 32 && expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

export async function POST(request) {
  if (!authorized(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    return Response.json(await reencryptGradingKeys());
  } catch (error) {
    console.error("grading key maintenance failed", { name: error?.name, message: error?.message });
    return Response.json({ ok: false, error: "maintenance failed" }, { status: 500 });
  }
}
