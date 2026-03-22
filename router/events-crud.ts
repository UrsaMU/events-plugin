import { dbojs } from "jsr:@ursamu/ursamu";
import {
  gameEvents, eventRsvps, getNextEventNumber, parseDateTime, normalizeEvent,
} from "../db.ts";
import { eventHooks } from "../hooks.ts";
import { getConfig } from "../config.ts";
import type { IGameEvent } from "../types.ts";
import { jsonResponse, isStaffUser, resolveEvent, withRsvpSummary } from "./helpers.ts";

// ─── GET /api/v1/events ───────────────────────────────────────────────────────

export async function listEvents(url: URL, userId: string, staff: boolean): Promise<Response> {
  const params  = url.searchParams;
  const statusF = params.get("status");
  const tagF    = params.get("tag");
  const fromF   = params.get("from") ? parseInt(params.get("from")!, 10) : null;
  const toF     = params.get("to")   ? parseInt(params.get("to")!,   10) : null;
  const limit   = Math.min(parseInt(params.get("limit")  || "50", 10), 200);
  const offset  = Math.max(parseInt(params.get("offset") || "0",  10), 0);

  let all = (await gameEvents.find({})).map(normalizeEvent);

  if (!staff) all = all.filter(e => e.status !== "cancelled" && e.status !== "pending");
  if (statusF) all = all.filter(e => e.status === statusF);
  if (tagF)    all = all.filter(e => e.tags.includes(tagF));
  if (fromF)   all = all.filter(e => e.startTime >= fromF);
  if (toF)     all = all.filter(e => e.startTime <= toF);

  all.sort((a, b) => a.startTime - b.startTime);
  const page   = all.slice(offset, offset + limit);
  const result = await Promise.all(page.map(e => withRsvpSummary(e, userId)));
  return jsonResponse({ total: all.length, events: result });
}

// ─── POST /api/v1/events ──────────────────────────────────────────────────────

export async function createEvent(req: Request, userId: string, staff: boolean): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

  const title       = typeof body.title       === "string" ? body.title.trim()       : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const startRaw    = typeof body.startTime   === "string" ? body.startTime.trim()   : "";

  if (!title || !description || (!startRaw && typeof body.startTime !== "number")) {
    return jsonResponse({ error: "title, description, and startTime are required" }, 400);
  }

  const startTime = typeof body.startTime === "number"
    ? body.startTime
    : parseDateTime(startRaw);
  if (!startTime) return jsonResponse({ error: "Invalid startTime format" }, 400);

  const endTime = body.endTime
    ? (typeof body.endTime === "number" ? body.endTime : parseDateTime(String(body.endTime)))
    : undefined;

  // Enforce per-player event limit for non-staff
  if (!staff) {
    const cfg  = await getConfig();
    if (cfg.maxPlayerEvents > 0) {
      const mine = await gameEvents.find({ createdBy: userId });
      const open = mine.filter(e => e.status === "upcoming" || e.status === "pending" || e.status === "active");
      if (open.length >= cfg.maxPlayerEvents) {
        return jsonResponse({ error: `You may have at most ${cfg.maxPlayerEvents} open event(s)` }, 403);
      }
    }
  }

  const player        = await dbojs.queryOne({ id: userId });
  const createdByName = (player && player.data?.name) || userId;
  const cfg           = await getConfig();
  const status        = (!staff && cfg.requireApproval) ? "pending" as const : "upcoming" as const;
  const num           = await getNextEventNumber();
  const now           = Date.now();

  const ev: IGameEvent = {
    id:              `ev-${num}`,
    number:          num,
    title,
    description,
    location:        typeof body.location === "string" ? body.location.trim() : undefined,
    startTime,
    endTime:         endTime || undefined,
    createdBy:       userId,
    createdByName,
    status,
    tags:            Array.isArray(body.tags) ? (body.tags as string[]).map(t => String(t).trim()) : [],
    maxAttendees:    typeof body.maxAttendees === "number" ? body.maxAttendees : 0,
    reminderMinutes: Array.isArray(body.reminderMinutes) ? (body.reminderMinutes as number[]) : [60, 15],
    remindersSent:   [],
    playerCreated:   !staff,
    createdAt:       now,
    updatedAt:       now,
  };

  await gameEvents.create(ev);
  await eventHooks.emit("event:created", ev);
  return jsonResponse(ev, 201);
}

// ─── GET /api/v1/events/:id ───────────────────────────────────────────────────

export async function getEvent(idParam: string, userId: string, staff: boolean): Promise<Response> {
  const ev = await resolveEvent(idParam);
  if (!ev) return jsonResponse({ error: "Not found" }, 404);
  if (!staff && (ev.status === "cancelled" || ev.status === "pending")) {
    return jsonResponse({ error: "Not found" }, 404);
  }

  const all       = await eventRsvps.find({ eventId: ev.id });
  const attending = all.filter(r => r.status === "attending");
  const maybe     = all.filter(r => r.status === "maybe");
  const waitlist  = all.filter(r => r.status === "waitlist").sort((a, b) => (a.waitlistPosition ?? 99) - (b.waitlistPosition ?? 99));
  const myRsvp    = all.find(r => r.playerId === userId) || null;
  const checkins  = attending.filter(r => r.checkedIn);

  return jsonResponse({
    ...ev,
    attendingCount: attending.length,
    maybeCount:     maybe.length,
    waitlistCount:  waitlist.length,
    checkinCount:   checkins.length,
    myRsvp:         myRsvp ? myRsvp.status : null,
    attendees:      attending.map(r => ({ id: r.playerId, name: r.playerName, checkedIn: r.checkedIn })),
    maybes:         maybe.map(r => ({ id: r.playerId, name: r.playerName })),
    waitlistQueue:  waitlist.map(r => ({ id: r.playerId, name: r.playerName, position: r.waitlistPosition })),
  });
}

// ─── PATCH /api/v1/events/:id ─────────────────────────────────────────────────

export async function updateEvent(req: Request, idParam: string, userId: string, staff: boolean): Promise<Response> {
  const ev = await resolveEvent(idParam);
  if (!ev) return jsonResponse({ error: "Not found" }, 404);

  // Staff or event creator can edit; creator can't change status
  const isCreator = ev.createdBy === userId;
  if (!staff && !isCreator) return jsonResponse({ error: "Forbidden" }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

  const ALLOWED_ALL    = ["title", "description", "location", "tags", "maxAttendees", "reminderMinutes"];
  const ALLOWED_STAFF  = [...ALLOWED_ALL, "status"];
  const allowed        = staff ? ALLOWED_STAFF : ALLOWED_ALL;
  const update: Partial<IGameEvent> = { updatedAt: Date.now() };

  for (const field of allowed) {
    if (field in body) (update as Record<string, unknown>)[field] = body[field];
  }

  if (typeof body.startTime === "string") {
    const t = parseDateTime(body.startTime); if (!t) return jsonResponse({ error: "Invalid startTime" }, 400); update.startTime = t;
  } else if (typeof body.startTime === "number") { update.startTime = body.startTime; }

  if (typeof body.endTime === "string") {
    const t = parseDateTime(body.endTime); if (!t) return jsonResponse({ error: "Invalid endTime" }, 400); update.endTime = t;
  } else if (typeof body.endTime === "number") { update.endTime = body.endTime; }

  const updated: IGameEvent = { ...ev, ...update };
  await gameEvents.update({ id: ev.id }, updated);

  if (updated.status !== ev.status) {
    if (updated.status === "cancelled") await eventHooks.emit("event:cancelled", updated);
    else if (updated.status === "completed") await eventHooks.emit("event:completed", updated);
    else await eventHooks.emit("event:updated", updated);
  } else {
    await eventHooks.emit("event:updated", updated);
  }

  return jsonResponse(updated);
}

// ─── DELETE /api/v1/events/:id ────────────────────────────────────────────────

export async function deleteEvent(idParam: string, userId: string, staff: boolean): Promise<Response> {
  const ev = await resolveEvent(idParam);
  if (!ev) return jsonResponse({ error: "Not found" }, 404);

  if (!staff && ev.createdBy !== userId) return jsonResponse({ error: "Forbidden" }, 403);

  await gameEvents.delete({ id: ev.id });
  await eventRsvps.delete({ eventId: ev.id });
  await eventHooks.emit("event:deleted", ev);
  return jsonResponse({ deleted: true });
}

export { isStaffUser };
