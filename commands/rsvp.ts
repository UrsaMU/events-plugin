import type { IUrsamuSDK } from "jsr:@ursamu/ursamu";
import { eventRsvps, eventNotifications, normalizeRsvp } from "../db.ts";
import { eventHooks } from "../hooks.ts";
import type { IGameEvent, IEventRSVP } from "../types.ts";
import {
  isStaff, isOwnerOrStaff, rsvpColor,
  getEventByNumber, getPlayerName, promoteFromWaitlist,
} from "./shared.ts";

const PREFIX = "%ch+event:%cn";

// ─── rsvp ────────────────────────────────────────────────────────────────────

/** +event/rsvp <#>[=attending|maybe|decline] */
export async function handleRsvp(u: IUrsamuSDK, arg: string): Promise<void> {
  const eqIdx  = arg.indexOf("=");
  const numStr = eqIdx !== -1 ? arg.slice(0, eqIdx).trim() : arg;
  const choice = (eqIdx !== -1 ? arg.slice(eqIdx + 1).trim() : "attending").toLowerCase();
  const num    = parseInt(numStr, 10);

  if (isNaN(num)) { u.send(`Usage: +event/rsvp <#>[=attending|maybe|decline]`); return; }

  const VALID = ["attending", "maybe", "declined", "decline"];
  if (!VALID.includes(choice)) {
    u.send(`${PREFIX} RSVP status must be: attending, maybe, or decline`);
    return;
  }
  const status: IEventRSVP["status"] = choice === "decline" ? "declined" : choice as IEventRSVP["status"];

  const ev = await getEventByNumber(num);
  if (!ev)                       { u.send(`${PREFIX} No event #${num} found.`); return; }
  if (ev.status === "cancelled") { u.send(`${PREFIX} That event has been cancelled.`); return; }
  if (ev.status === "completed") { u.send(`${PREFIX} That event has already occurred.`); return; }
  if (ev.status === "pending")   { u.send(`${PREFIX} That event is pending approval.`); return; }

  const existing = await eventRsvps.queryOne({ eventId: ev.id, playerId: u.me.id });

  // Capacity check — only matters when requesting "attending"
  if (status === "attending" && ev.maxAttendees > 0) {
    const attending      = await eventRsvps.find({ eventId: ev.id, status: "attending" });
    const alreadyAttending = existing?.status === "attending";

    if (!alreadyAttending && attending.length >= ev.maxAttendees) {
      // Auto-waitlist instead of rejecting
      const waitlisted = await eventRsvps.find({ eventId: ev.id, status: "waitlist" });
      const position   = waitlisted.length + 1;

      if (existing) {
        const updated: IEventRSVP = { ...normalizeRsvp(existing), status: "waitlist", waitlistPosition: position };
        await eventRsvps.update({ id: existing.id }, updated);
        await eventHooks.emit("event:rsvp", ev, updated);
      } else {
        const rsvp: IEventRSVP = {
          id: crypto.randomUUID(), eventId: ev.id,
          playerId: u.me.id, playerName: await getPlayerName(u.me.id),
          status: "waitlist", waitlistPosition: position,
          checkedIn: false, createdAt: Date.now(),
        };
        await eventRsvps.create(rsvp);
        await eventHooks.emit("event:rsvp", ev, rsvp);
      }

      u.send(`${PREFIX} "${ev.title}" is full — you've been added to the %ch%cxwaitlist%cn at position ${position}.`);
      return;
    }
  }

  // Normal RSVP create or update
  const playerName = await getPlayerName(u.me.id);

  if (existing) {
    const updated: IEventRSVP = { ...normalizeRsvp(existing), status, waitlistPosition: undefined };
    await eventRsvps.update({ id: existing.id }, updated);
    await eventHooks.emit("event:rsvp", ev, updated);
    u.send(`${PREFIX} RSVP updated to ${rsvpColor(status)}${status}%cn for "${ev.title}".`);
  } else {
    const rsvp: IEventRSVP = {
      id: crypto.randomUUID(), eventId: ev.id,
      playerId: u.me.id, playerName,
      status, checkedIn: false, createdAt: Date.now(),
    };
    await eventRsvps.create(rsvp);
    await eventHooks.emit("event:rsvp", ev, rsvp);
    u.send(`${PREFIX} RSVP'd ${rsvpColor(status)}${status}%cn for "${ev.title}".`);
  }
}

// ─── unrsvp ──────────────────────────────────────────────────────────────────

/** +event/unrsvp <#> */
export async function handleUnrsvp(u: IUrsamuSDK, arg: string): Promise<void> {
  const num = parseInt(arg, 10);
  if (isNaN(num)) { u.send(`Usage: +event/unrsvp <#>`); return; }

  const ev = await getEventByNumber(num);
  if (!ev) { u.send(`${PREFIX} No event #${num} found.`); return; }

  const existing = await eventRsvps.queryOne({ eventId: ev.id, playerId: u.me.id });
  if (!existing) { u.send(`${PREFIX} You have no RSVP to cancel.`); return; }

  const wasAttending = existing.status === "attending";
  await eventRsvps.delete({ id: existing.id });
  await eventHooks.emit("event:rsvp-cancelled", ev, normalizeRsvp(existing));

  if (wasAttending) {
    await promoteFromWaitlist(ev, (msg, pid) => u.send(msg, pid));
  }

  u.send(`${PREFIX} RSVP cancelled for "${ev.title}".`);
}

// ─── checkin ─────────────────────────────────────────────────────────────────

/** +event/checkin <#>[=<player>] — Self check-in or staff/creator check-in by name. */
export async function handleCheckin(u: IUrsamuSDK, arg: string): Promise<void> {
  const eqIdx  = arg.indexOf("=");
  const numStr = eqIdx !== -1 ? arg.slice(0, eqIdx).trim() : arg;
  const target = eqIdx !== -1 ? arg.slice(eqIdx + 1).trim() : "";
  const num    = parseInt(numStr, 10);

  if (isNaN(num)) { u.send(`Usage: +event/checkin <#>[=<player>]`); return; }

  const ev = await getEventByNumber(num);
  if (!ev)                    { u.send(`${PREFIX} No event #${num} found.`); return; }
  if (ev.status !== "active") { u.send(`${PREFIX} Check-in is only available during an active event.`); return; }

  if (!target) {
    await selfCheckin(u, ev);
  } else {
    if (!isOwnerOrStaff(u, ev)) {
      u.send(`${PREFIX} Only staff or the event organizer can check in other players.`);
      return;
    }
    await staffCheckin(u, ev, target);
  }
}

async function selfCheckin(u: IUrsamuSDK, ev: IGameEvent): Promise<void> {
  const rsvp = await eventRsvps.queryOne({ eventId: ev.id, playerId: u.me.id });

  if (!rsvp || rsvp.status !== "attending") {
    u.send(`${PREFIX} You must have an "attending" RSVP to check in.`);
    return;
  }
  if (rsvp.checkedIn) {
    u.send(`${PREFIX} You are already checked in to "${ev.title}".`);
    return;
  }

  const updated: IEventRSVP = { ...normalizeRsvp(rsvp), checkedIn: true, checkedInAt: Date.now() };
  await eventRsvps.update({ id: rsvp.id }, updated);
  await eventHooks.emit("event:checkin", ev, updated);
  u.send(`${PREFIX} You are now %ch%cgchecked in%cn to "${ev.title}".`);
}

async function staffCheckin(u: IUrsamuSDK, ev: IGameEvent, playerName: string): Promise<void> {
  const allRsvps = await eventRsvps.find({ eventId: ev.id, status: "attending" });
  // stripSubs before using as search term — prevents MUSH codes in lookup
  const clean    = u.util.stripSubs(playerName).toLowerCase();
  const rsvp     = allRsvps.find(r => r.playerName.toLowerCase().includes(clean));

  if (!rsvp) {
    u.send(`${PREFIX} No attending RSVP found for "${playerName}".`);
    return;
  }
  if (rsvp.checkedIn) {
    u.send(`${PREFIX} ${rsvp.playerName} is already checked in.`);
    return;
  }

  const updated: IEventRSVP = { ...normalizeRsvp(rsvp), checkedIn: true, checkedInAt: Date.now() };
  await eventRsvps.update({ id: rsvp.id }, updated);
  await eventHooks.emit("event:checkin", ev, updated);

  u.send(`${PREFIX} ${rsvp.playerName} is now %ch%cgchecked in%cn to "${ev.title}".`);
  u.send(`${PREFIX} ${u.me.name} has checked you in to "${ev.title}".`, rsvp.playerId);

  // Queue offline notification in case the player isn't connected
  await eventNotifications.create({
    id:        crypto.randomUUID(),
    playerId:  rsvp.playerId,
    message:   `${PREFIX} ${u.me.name} has checked you in to "${ev.title}".`,
    eventId:   ev.id,
    createdAt: Date.now(),
  });
}
