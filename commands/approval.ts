import type { IUrsamuSDK } from "jsr:@ursamu/ursamu";
import { gameEvents, eventRsvps, eventNotifications, normalizeEvent } from "../db.ts";
import { eventHooks } from "../hooks.ts";
import type { IGameEvent } from "../types.ts";
import { isStaff, getEventByNumber } from "./shared.ts";

const PREFIX = "%ch+event:%cn";

// ─── approve ─────────────────────────────────────────────────────────────────

/** +event/approve <#> — staff only. Moves a pending event to upcoming. */
export async function handleApprove(u: IUrsamuSDK, arg: string): Promise<void> {
  if (!isStaff(u)) { u.send(`${PREFIX} Permission denied.`); return; }

  const num = parseInt(arg, 10);
  if (isNaN(num)) { u.send(`Usage: +event/approve <#>`); return; }

  const raw = await getEventByNumber(num);
  if (!raw) { u.send(`${PREFIX} No event #${num} found.`); return; }
  const ev = normalizeEvent(raw);

  if (ev.status !== "pending") {
    u.send(`${PREFIX} Event #${num} is not pending (status: ${ev.status}).`);
    return;
  }

  const updated: IGameEvent = { ...ev, status: "upcoming", updatedAt: Date.now() };
  await gameEvents.update({ id: ev.id }, updated);
  await eventHooks.emit("event:approved", updated);

  u.send(`${PREFIX} Event #${num} "${ev.title}" has been %ch%cgapproved%cn.`);

  // Notify the creator
  const msg = `${PREFIX} Your event "${ev.title}" (#${num}) has been %ch%cgapproved%cn by staff!`;
  u.send(msg, ev.createdBy);
  await eventNotifications.create({
    id:        crypto.randomUUID(),
    playerId:  ev.createdBy,
    message:   msg,
    eventId:   ev.id,
    createdAt: Date.now(),
  });
}

// ─── reject ───────────────────────────────────────────────────────────────────

/** +event/reject <#> — staff only. Permanently deletes a pending event. */
export async function handleReject(u: IUrsamuSDK, arg: string): Promise<void> {
  if (!isStaff(u)) { u.send(`${PREFIX} Permission denied.`); return; }

  const num = parseInt(arg, 10);
  if (isNaN(num)) { u.send(`Usage: +event/reject <#>`); return; }

  const raw = await getEventByNumber(num);
  if (!raw) { u.send(`${PREFIX} No event #${num} found.`); return; }
  const ev = normalizeEvent(raw);

  if (ev.status !== "pending") {
    u.send(`${PREFIX} Event #${num} is not pending (status: ${ev.status}).`);
    return;
  }

  await gameEvents.delete({ id: ev.id });
  await eventRsvps.delete({ eventId: ev.id });
  await eventHooks.emit("event:deleted", ev);

  u.send(`${PREFIX} Event #${num} "${ev.title}" has been %ch%crrejected%cn and removed.`);

  const msg = `${PREFIX} Your event "${ev.title}" (#${num}) was %ch%crrejected%cn by staff.`;
  u.send(msg, ev.createdBy);
  await eventNotifications.create({
    id:        crypto.randomUUID(),
    playerId:  ev.createdBy,
    message:   msg,
    eventId:   ev.id,
    createdAt: Date.now(),
  });
}
