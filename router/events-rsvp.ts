import { dbojs } from "jsr:@ursamu/ursamu";
import { eventRsvps, eventNotifications, normalizeEvent, normalizeRsvp } from "../db.ts";
import { eventHooks } from "../hooks.ts";
import type { IGameEvent, IEventRSVP } from "../types.ts";
import { jsonResponse, resolveEvent, promoteFromWaitlist } from "./helpers.ts";

// ─── GET /api/v1/events/:id/rsvps ────────────────────────────────────────────

export async function listRsvps(idParam: string, userId: string, staff: boolean): Promise<Response> {
  const ev = await resolveEvent(idParam);
  if (!ev) return jsonResponse({ error: "Not found" }, 404);

  const all = await eventRsvps.find({ eventId: ev.id });

  if (staff) return jsonResponse(all);

  const attending  = all.filter(r => r.status === "attending");
  const maybe      = all.filter(r => r.status === "maybe");
  const waitlisted = all.filter(r => r.status === "waitlist");
  const myRsvp     = all.find(r => r.playerId === userId) || null;
  const checkins   = attending.filter(r => r.checkedIn);

  return jsonResponse({
    attendingCount: attending.length,
    maybeCount:     maybe.length,
    waitlistCount:  waitlisted.length,
    checkinCount:   checkins.length,
    myRsvp:         myRsvp ? { status: myRsvp.status, checkedIn: myRsvp.checkedIn } : null,
    attendees:      attending.map(r => ({ name: r.playerName, checkedIn: r.checkedIn })),
  });
}

// ─── POST /api/v1/events/:id/rsvp ────────────────────────────────────────────

export async function createRsvp(req: Request, idParam: string, userId: string): Promise<Response> {
  const raw = await resolveEvent(idParam);
  if (!raw) return jsonResponse({ error: "Not found" }, 404);
  const ev = normalizeEvent(raw);

  if (ev.status === "cancelled") return jsonResponse({ error: "Event is cancelled" }, 400);
  if (ev.status === "completed") return jsonResponse({ error: "Event has already occurred" }, 400);
  if (ev.status === "pending")   return jsonResponse({ error: "Event is pending approval" }, 400);

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

  const rawStatus = typeof body.status === "string" ? body.status.trim().toLowerCase() : "attending";
  if (!["attending", "maybe", "declined"].includes(rawStatus)) {
    return jsonResponse({ error: "status must be attending, maybe, or declined" }, 400);
  }
  const status = rawStatus as IEventRSVP["status"];
  const note   = typeof body.note === "string" ? body.note.trim() : undefined;

  const existing = await eventRsvps.queryOne({ eventId: ev.id, playerId: userId });

  if (status === "attending" && ev.maxAttendees > 0) {
    const attending      = await eventRsvps.find({ eventId: ev.id, status: "attending" });
    const alreadyIn      = existing?.status === "attending";

    if (!alreadyIn && attending.length >= ev.maxAttendees) {
      return await autoWaitlist(ev, userId, existing, note);
    }
  }

  const player     = await dbojs.queryOne({ id: userId });
  const playerName = (player && player.data?.name) || userId;

  if (existing) {
    const updated: IEventRSVP = {
      ...normalizeRsvp(existing), status, note, waitlistPosition: undefined,
    };
    await eventRsvps.update({ id: existing.id }, updated);
    await eventHooks.emit("event:rsvp", ev, updated);
    return jsonResponse(updated);
  }

  const rsvp: IEventRSVP = {
    id: crypto.randomUUID(), eventId: ev.id,
    playerId: userId, playerName,
    status, note, checkedIn: false, createdAt: Date.now(),
  };
  await eventRsvps.create(rsvp);
  await eventHooks.emit("event:rsvp", ev, rsvp);
  return jsonResponse(rsvp, 201);
}

async function autoWaitlist(
  ev: IGameEvent,
  userId: string,
  existing: IEventRSVP | null,
  note: string | undefined,
): Promise<Response> {
  const waitlisted = await eventRsvps.find({ eventId: ev.id, status: "waitlist" });
  const position   = waitlisted.length + 1;

  const player     = await dbojs.queryOne({ id: userId });
  const playerName = (player && player.data?.name) || userId;

  if (existing) {
    const updated: IEventRSVP = {
      ...normalizeRsvp(existing), status: "waitlist", waitlistPosition: position, note,
    };
    await eventRsvps.update({ id: existing.id }, updated);
    await eventHooks.emit("event:rsvp", ev, updated);
    return jsonResponse({ ...updated, waitlistPosition: position }, 201);
  }

  const rsvp: IEventRSVP = {
    id: crypto.randomUUID(), eventId: ev.id,
    playerId: userId, playerName,
    status: "waitlist", waitlistPosition: position,
    note, checkedIn: false, createdAt: Date.now(),
  };
  await eventRsvps.create(rsvp);
  await eventHooks.emit("event:rsvp", ev, rsvp);
  return jsonResponse({ ...rsvp, message: `Event is full — added to waitlist at position ${position}` }, 201);
}

// ─── DELETE /api/v1/events/:id/rsvp ──────────────────────────────────────────

export async function cancelRsvp(idParam: string, userId: string): Promise<Response> {
  const ev = await resolveEvent(idParam);
  if (!ev) return jsonResponse({ error: "Not found" }, 404);

  const existing = await eventRsvps.queryOne({ eventId: ev.id, playerId: userId });
  if (!existing) return jsonResponse({ error: "No RSVP to cancel" }, 404);

  const wasAttending = existing.status === "attending";
  await eventRsvps.delete({ id: existing.id });
  await eventHooks.emit("event:rsvp-cancelled", ev, normalizeRsvp(existing));

  if (wasAttending) {
    const promoted = await promoteFromWaitlist(ev);
    if (promoted) {
      await eventHooks.emit("event:waitlist-promoted", ev, promoted);
      await eventNotifications.create({
        id:        crypto.randomUUID(),
        playerId:  promoted.playerId,
        message:   `%ch%cy[EVENT]%cn You've been promoted from the waitlist to attending for "${ev.title}"!`,
        eventId:   ev.id,
        createdAt: Date.now(),
      });
    }
  }

  return jsonResponse({ deleted: true });
}

// ─── POST /api/v1/events/:id/checkin ─────────────────────────────────────────

export async function checkinRsvp(req: Request, idParam: string, userId: string, staff: boolean): Promise<Response> {
  const ev = await resolveEvent(idParam);
  if (!ev) return jsonResponse({ error: "Not found" }, 404);
  if (ev.status !== "active") return jsonResponse({ error: "Check-in only available during active events" }, 400);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* no body = self check-in */ }

  const targetPlayerId = typeof body.playerId === "string" ? body.playerId.trim() : userId;

  if (targetPlayerId !== userId && !staff && ev.createdBy !== userId) {
    return jsonResponse({ error: "Only staff or the event organizer can check in other players" }, 403);
  }

  const rsvp = await eventRsvps.queryOne({ eventId: ev.id, playerId: targetPlayerId });
  if (!rsvp || rsvp.status !== "attending") {
    return jsonResponse({ error: "Player must have an attending RSVP to check in" }, 400);
  }
  if (rsvp.checkedIn) return jsonResponse({ error: "Player is already checked in" }, 400);

  const updated: IEventRSVP = { ...normalizeRsvp(rsvp), checkedIn: true, checkedInAt: Date.now() };
  await eventRsvps.update({ id: rsvp.id }, updated);
  await eventHooks.emit("event:checkin", ev, updated);
  return jsonResponse(updated);
}

// ─── PATCH /api/v1/events/:id/approve ────────────────────────────────────────

export async function approveEvent(idParam: string, userId: string): Promise<Response> {
  const ev = await resolveEvent(idParam);
  if (!ev) return jsonResponse({ error: "Not found" }, 404);
  if (ev.status !== "pending") return jsonResponse({ error: "Event is not pending" }, 400);

  const { gameEvents } = await import("../db.ts");
  const updated = { ...ev, status: "upcoming" as const, updatedAt: Date.now() };
  await gameEvents.update({ id: ev.id }, updated);
  await eventHooks.emit("event:approved", updated);

  await eventNotifications.create({
    id:        crypto.randomUUID(),
    playerId:  ev.createdBy,
    message:   `%ch%cy[EVENT]%cn Your event "${ev.title}" has been %ch%cgapproved%cn by staff!`,
    eventId:   ev.id,
    createdAt: Date.now(),
  });

  return jsonResponse(updated);
}
