import { dbojs } from "jsr:@ursamu/ursamu";
import { gameEvents, eventRsvps, normalizeEvent, normalizeRsvp } from "../db.ts";
import type { IGameEvent, IEventRSVP } from "../types.ts";

export const JSON_HEADERS = { "Content-Type": "application/json" };

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

/** Check staff flags safely — handles Set (runtime), Array, or space-separated string (tests). */
function flagsHas(flags: unknown, flag: string): boolean {
  if (flags instanceof Set)      return flags.has(flag);
  if (Array.isArray(flags))      return flags.includes(flag);
  if (typeof flags === "string") return flags.split(/\s+/).includes(flag);
  return false;
}

export async function isStaffUser(userId: string): Promise<boolean> {
  const player = await dbojs.queryOne({ id: userId });
  if (!player) return false;
  return flagsHas(player.flags, "admin") ||
         flagsHas(player.flags, "wizard") ||
         flagsHas(player.flags, "superuser");
}

/** Resolve an event by sequential number ("3") or internal ID ("ev-3"). */
export async function resolveEvent(idParam: string): Promise<IGameEvent | null> {
  const num = parseInt(idParam, 10);
  if (!isNaN(num)) {
    const found = await gameEvents.queryOne({ number: num });
    return found ? normalizeEvent(found) : null;
  }
  const found = await gameEvents.queryOne({ id: idParam });
  return found ? normalizeEvent(found) : null;
}

/** Attach RSVP summary counts and the caller's own RSVP to an event. */
export async function withRsvpSummary(ev: IGameEvent, userId?: string) {
  const all        = await eventRsvps.find({ eventId: ev.id });
  const attending  = all.filter(r => r.status === "attending");
  const maybe      = all.filter(r => r.status === "maybe");
  const waitlisted = all.filter(r => r.status === "waitlist");
  const myRsvp     = userId ? all.find(r => r.playerId === userId) || null : null;
  return {
    ...ev,
    attendingCount: attending.length,
    maybeCount:     maybe.length,
    waitlistCount:  waitlisted.length,
    myRsvp:         myRsvp ? myRsvp.status : null,
  };
}

/** Promote the first waitlisted RSVP to attending. Returns the promoted RSVP or null. */
export async function promoteFromWaitlist(ev: IGameEvent): Promise<IEventRSVP | null> {
  const waitlisted = (await eventRsvps.find({ eventId: ev.id, status: "waitlist" }))
    .sort((a, b) => (a.waitlistPosition ?? 99) - (b.waitlistPosition ?? 99));

  if (!waitlisted.length) return null;

  const promoted    = normalizeRsvp(waitlisted[0]);
  const updatedRsvp: IEventRSVP = { ...promoted, status: "attending", waitlistPosition: undefined };
  await eventRsvps.update({ id: promoted.id }, updatedRsvp);

  for (let i = 1; i < waitlisted.length; i++) {
    await eventRsvps.update({ id: waitlisted[i].id }, { ...waitlisted[i], waitlistPosition: i });
  }

  return updatedRsvp;
}
