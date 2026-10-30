import crypto from "node:crypto";
import { syncDriveFolderDocuments } from "../../../../db/sync-drive-folder-documents.mjs";

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
    return Response.json(await syncDriveFolderDocuments());
  } catch {
    return Response.json({ ok: false, error: "folder sync failed" }, { status: 500 });
  }
}
