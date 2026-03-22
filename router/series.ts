import { dbojs } from "jsr:@ursamu/ursamu";
import { eventSeries, getNextSeriesNumber } from "../db.ts";
import { eventHooks } from "../hooks.ts";
import type { IEventSeries } from "../types.ts";
import { jsonResponse } from "./helpers.ts";
import { cronNext } from "../series.ts";

// ─── GET /api/v1/events/series ────────────────────────────────────────────────

export async function listSeries(): Promise<Response> {
  const all = await eventSeries.find({});
  const result = all.sort((a, b) => a.number - b.number).map(s => ({
    ...s,
    nextOccurrence: cronNext(s.cronExpression, new Date())?.getTime() ?? null,
  }));
  return jsonResponse(result);
}

// ─── POST /api/v1/events/series ───────────────────────────────────────────────

export async function createSeries(req: Request, userId: string): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

  const title       = typeof body.title       === "string" ? body.title.trim()       : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const cron        = typeof body.cronExpression === "string" ? body.cronExpression.trim() : "";

  if (!title || !description || !cron) {
    return jsonResponse({ error: "title, description, and cronExpression are required" }, 400);
  }

  if (!cronNext(cron, new Date())) {
    return jsonResponse({ error: "Invalid cronExpression — use 5-field standard cron" }, 400);
  }

  const player        = await dbojs.queryOne({ id: userId });
  const createdByName = (player && player.data?.name) || userId;
  const num           = await getNextSeriesNumber();
  const now           = Date.now();

  const series: IEventSeries = {
    id:              `series-${num}`,
    number:          num,
    title,
    description,
    location:        typeof body.location === "string" ? body.location.trim() : undefined,
    cronExpression:  cron,
    durationMinutes: typeof body.durationMinutes === "number" ? body.durationMinutes : 0,
    tags:            Array.isArray(body.tags) ? (body.tags as string[]).map(t => String(t).trim()) : [],
    maxAttendees:    typeof body.maxAttendees === "number" ? body.maxAttendees : 0,
    reminderMinutes: Array.isArray(body.reminderMinutes) ? (body.reminderMinutes as number[]) : [60, 15],
    active:          true,
    createdBy:       userId,
    createdByName,
    createdAt:       now,
    updatedAt:       now,
  };

  await eventSeries.create(series);
  await eventHooks.emit("event:series-created", series);
  return jsonResponse(series, 201);
}

// ─── PATCH /api/v1/events/series/:id ─────────────────────────────────────────

export async function updateSeries(req: Request, idParam: string): Promise<Response> {
  const num    = parseInt(idParam, 10);
  const series = isNaN(num)
    ? await eventSeries.queryOne({ id: idParam })
    : await eventSeries.queryOne({ number: num });

  if (!series) return jsonResponse({ error: "Not found" }, 404);

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

  const ALLOWED = ["title", "description", "location", "durationMinutes",
                   "tags", "maxAttendees", "reminderMinutes", "active"];
  const update: Partial<IEventSeries> = { updatedAt: Date.now() };

  for (const field of ALLOWED) {
    if (field in body) (update as Record<string, unknown>)[field] = body[field];
  }

  if (typeof body.cronExpression === "string") {
    if (!cronNext(body.cronExpression, new Date())) {
      return jsonResponse({ error: "Invalid cronExpression" }, 400);
    }
    update.cronExpression = body.cronExpression.trim();
  }

  const updated: IEventSeries = { ...series, ...update };
  await eventSeries.update({ id: series.id }, updated);
  return jsonResponse(updated);
}
