import { dbojs } from "jsr:@ursamu/ursamu";
import type { IUrsamuSDK } from "jsr:@ursamu/ursamu";
import { gameEvents, eventRsvps, eventNotifications, normalizeRsvp } from "../db.ts";
import { eventHooks } from "../hooks.ts";
import type { IGameEvent, IEventRSVP, EventStatus, RsvpStatus } from "../types.ts";

export { gameEvents, eventRsvps };

// ─── permission helpers ───────────────────────────────────────────────────────

export function isStaff(u: IUrsamuSDK): boolean {
  return u.me.flags.has("admin") || u.me.flags.has("wizard") || u.me.flags.has("superuser");
}

/** Returns true if the caller is staff OR the creator of the event. */
export function isOwnerOrStaff(u: IUrsamuSDK, ev: IGameEvent): boolean {
  return isStaff(u) || ev.createdBy === u.me.id;
}

// ─── display helpers ─────────────────────────────────────────────────────────

export function statusColor(s: EventStatus): string {
  switch (s) {
    case "pending":   return "%ch%cx";
    case "upcoming":  return "%ch%cg";
    case "active":    return "%ch%cy";
    case "completed": return "%cn";
    case "cancelled": return "%ch%cr";
  }
}

export function rsvpColor(s: RsvpStatus): string {
  switch (s) {
    case "attending": return "%ch%cg";
    case "maybe":     return "%cy";
    case "declined":  return "%cr";
    case "waitlist":  return "%ch%cx";
  }
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

export async function getEventByNumber(n: number): Promise<IGameEvent | null> {
  return await gameEvents.queryOne({ number: n }) || null;
}

export async function getPlayerName(id: string): Promise<string> {
  const p = await dbojs.queryOne({ id });
  return (p && p.data?.name) || id;
}

// ─── notification delivery ───────────────────────────────────────────────────

/**
 * Deliver any queued notifications to the calling player.
 * Call at the top of every +event exec handler.
 */
export async function deliverPendingNotifications(u: IUrsamuSDK): Promise<void> {
  const pending = await eventNotifications.find({ playerId: u.me.id });
  for (const n of pending) {
    u.send(n.message);
    await eventNotifications.delete({ id: n.id });
  }
}

// ─── waitlist promotion ───────────────────────────────────────────────────────

/**
 * Promote the first waitlisted attendee to "attending" after a slot opens.
 *
 * @param ev      The event (used for display name and hook payload)
 * @param sendFn  `(msg, playerId) => void` — notifies the promoted player in-game
 */
export async function promoteFromWaitlist(
  ev: IGameEvent,
  sendFn: (msg: string, playerId: string) => void,
): Promise<void> {
  const waitlisted = (await eventRsvps.find({ eventId: ev.id, status: "waitlist" }))
    .sort((a, b) => (a.waitlistPosition ?? 99) - (b.waitlistPosition ?? 99));

  if (!waitlisted.length) return;

  const promoted     = normalizeRsvp(waitlisted[0]);
  const updatedRsvp: IEventRSVP = { ...promoted, status: "attending", waitlistPosition: undefined };
  await eventRsvps.update({ id: promoted.id }, updatedRsvp);

  // Re-number remaining waitlist entries (1-based)
  for (let i = 1; i < waitlisted.length; i++) {
    await eventRsvps.update({ id: waitlisted[i].id }, { ...waitlisted[i], waitlistPosition: i });
  }

  const msg = `%ch%cy[EVENT]%cn You've been moved from the waitlist to %ch%cgattending%cn for "${ev.title}"!`;
  sendFn(msg, promoted.playerId);

  // Also queue for offline delivery (poller/login delivery)
  await eventNotifications.create({
    id:        crypto.randomUUID(),
    playerId:  promoted.playerId,
    message:   msg,
    eventId:   ev.id,
    createdAt: Date.now(),
  });

  await eventHooks.emit("event:waitlist-promoted", ev, updatedRsvp);
}
