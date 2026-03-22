import { getConfig, updateConfig } from "../config.ts";
import { jsonResponse } from "./helpers.ts";

// ─── GET /api/v1/events/config ────────────────────────────────────────────────

export async function getConfigRoute(): Promise<Response> {
  return jsonResponse(await getConfig());
}

// ─── PATCH /api/v1/events/config ─────────────────────────────────────────────

export async function updateConfigRoute(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

  const patch: Parameters<typeof updateConfig>[0] = {};

  if (typeof body.requireApproval === "boolean")  patch.requireApproval = body.requireApproval;
  if (typeof body.pollIntervalMs  === "number")   patch.pollIntervalMs  = Math.max(5_000, body.pollIntervalMs);
  if (typeof body.maxPlayerEvents === "number")   patch.maxPlayerEvents = Math.max(0, body.maxPlayerEvents);

  return jsonResponse(await updateConfig(patch));
}
