import type { IUrsamuSDK } from "jsr:@ursamu/ursamu";
import {
  gameEvents, getNextEventNumber, parseDateTime, formatDateTime, normalizeEvent,
} from "../db.ts";
import { eventHooks } from "../hooks.ts";
import { getConfig } from "../config.ts";
import type { IGameEvent } from "../types.ts";
import { isStaff, isOwnerOrStaff, statusColor, getEventByNumber, getPlayerName } from "./shared.ts";

const PREFIX = "%ch+event:%cn";

// ─── create ───────────────────────────────────────────────────────────────────

/** +event/create <title>=<YYYY-MM-DD HH:MM>/<desc> — available to all players. */
export async function handleCreate(u: IUrsamuSDK, arg: string): Promise<void> {
  const cfg    = await getConfig();
  const staff  = isStaff(u);

  // Enforce per-player event limit for non-staff
  if (!staff && cfg.maxPlayerEvents > 0) {
    const mine = await gameEvents.find({ createdBy: u.me.id });
    const open = mine.filter(e => e.status === "upcoming" || e.status === "pending" || e.status === "active");
    if (open.length >= cfg.maxPlayerEvents) {
      u.send(`${PREFIX} You may have at most ${cfg.maxPlayerEvents} open event(s) at a time.`);
      return;
    }
  }

  const eqIdx = arg.indexOf("=");
  if (eqIdx === -1) { u.send(`Usage: +event/create <title>=<YYYY-MM-DD HH:MM>/<description>`); return; }

  // stripSubs before storing — MUSH codes must not land in event titles or descriptions
  const title = u.util.stripSubs(arg.slice(0, eqIdx)).trim();
  const rest  = arg.slice(eqIdx + 1);
  const slash = rest.indexOf("/");

  if (slash === -1) { u.send(`Usage: +event/create <title>=<YYYY-MM-DD HH:MM>/<description>`); return; }

  const dateStr = rest.slice(0, slash).trim();
  const desc    = u.util.stripSubs(rest.slice(slash + 1)).trim();

  if (!title || !desc) { u.send(`Usage: +event/create <title>=<YYYY-MM-DD HH:MM>/<description>`); return; }

  const startTime = parseDateTime(dateStr);
  if (!startTime) {
    u.send(`${PREFIX} Invalid date "${dateStr}". Use: YYYY-MM-DD or YYYY-MM-DD HH:MM`);
    return;
  }

  const status     = (!staff && cfg.requireApproval) ? "pending" as const : "upcoming" as const;
  const num        = await getNextEventNumber();
  const now        = Date.now();
  const playerName = await getPlayerName(u.me.id);

  const ev: IGameEvent = {
    id:              `ev-${num}`,
    number:          num,
    title,
    description:     desc,
    startTime,
    createdBy:       u.me.id,
    createdByName:   playerName,
    status,
    tags:            [],
    maxAttendees:    0,
    reminderMinutes: [60, 15],
    remindersSent:   [],
    playerCreated:   !staff,
    createdAt:       now,
    updatedAt:       now,
  };

  await gameEvents.create(ev);
  await eventHooks.emit("event:created", ev);

  if (status === "pending") {
    u.send(`${PREFIX} Event #${num} "${title}" submitted — pending staff approval.`);
  } else {
    u.send(`${PREFIX} Event #${num} "${title}" created for ${formatDateTime(startTime)}.`);
  }
}

// ─── edit ─────────────────────────────────────────────────────────────────────

/** +event/edit <#>/<field>=<value> — staff or event creator. */
export async function handleEdit(u: IUrsamuSDK, arg: string): Promise<void> {
  const slash = arg.indexOf("/");
  const eq    = arg.indexOf("=");
  if (slash === -1 || eq === -1 || eq < slash) {
    u.send(`Usage: +event/edit <#>/<field>=<value>`);
    return;
  }

  const num   = parseInt(arg.slice(0, slash).trim(), 10);
  const field = arg.slice(slash + 1, eq).trim().toLowerCase();
  // stripSubs before storing — MUSH codes must not land in DB fields
  const value = u.util.stripSubs(arg.slice(eq + 1)).trim();
  if (isNaN(num)) { u.send(`Usage: +event/edit <#>/<field>=<value>`); return; }

  const raw = await getEventByNumber(num);
  if (!raw) { u.send(`${PREFIX} No event #${num} found.`); return; }
  const ev = normalizeEvent(raw);

  if (!isOwnerOrStaff(u, ev)) { u.send(`${PREFIX} Permission denied.`); return; }

  const update: Partial<IGameEvent> = { updatedAt: Date.now() };
  const FIELDS = "title, description, location, starttime, endtime, maxattendees, tags, reminders";

  switch (field) {
    case "title":        update.title       = value; break;
    case "description":  update.description = value; break;
    case "location":     update.location    = value; break;
    case "starttime":    { const t = parseDateTime(value); if (!t) { u.send(`${PREFIX} Invalid date.`); return; } update.startTime = t; break; }
    case "endtime":      { const t = parseDateTime(value); if (!t) { u.send(`${PREFIX} Invalid date.`); return; } update.endTime = t; break; }
    case "maxattendees": { const n = parseInt(value, 10); if (isNaN(n) || n < 0) { u.send(`${PREFIX} maxattendees must be ≥ 0.`); return; } update.maxAttendees = n; break; }
    case "tags":         update.tags = value.split(",").map(t => t.trim()).filter(Boolean); break;
    case "reminders":    update.reminderMinutes = value.split(",").map(m => parseInt(m.trim(), 10)).filter(n => !isNaN(n) && n > 0); break;
    default:
      u.send(`${PREFIX} Unknown field "${field}". Valid: ${FIELDS}`);
      return;
  }

  await gameEvents.update({ id: ev.id }, { ...ev, ...update });
  await eventHooks.emit("event:updated", { ...ev, ...update });
  u.send(`${PREFIX} Event #${num} updated (${field}).`);
}

// ─── status / cancel / delete ────────────────────────────────────────────────

/** +event/status <#>=<status> — staff only. */
export async function handleStatus(u: IUrsamuSDK, arg: string): Promise<void> {
  if (!isStaff(u)) { u.send(`${PREFIX} Permission denied.`); return; }

  const eqIdx = arg.indexOf("=");
  if (eqIdx === -1) { u.send(`Usage: +event/status <#>=<upcoming|active|completed|cancelled>`); return; }

  const num    = parseInt(arg.slice(0, eqIdx).trim(), 10);
  const status = arg.slice(eqIdx + 1).trim().toLowerCase();
  if (isNaN(num)) { u.send(`Usage: +event/status <#>=<status>`); return; }
  if (!["upcoming", "active", "completed", "cancelled"].includes(status)) {
    u.send(`${PREFIX} Status must be: upcoming, active, completed, cancelled`);
    return;
  }

  const raw = await getEventByNumber(num);
  if (!raw) { u.send(`${PREFIX} No event #${num} found.`); return; }
  const ev = normalizeEvent(raw);

  const updated: IGameEvent = { ...ev, status: status as IGameEvent["status"], updatedAt: Date.now() };
  await gameEvents.update({ id: ev.id }, updated);

  if (status === "cancelled") await eventHooks.emit("event:cancelled", updated);
  else if (status === "completed") await eventHooks.emit("event:completed", updated);
  else await eventHooks.emit("event:updated", updated);

  u.send(`${PREFIX} Event #${num} status set to ${statusColor(updated.status)}${status}%cn.`);
}

/** +event/cancel <#> — staff or event creator. */
export async function handleCancel(u: IUrsamuSDK, arg: string): Promise<void> {
  const num = parseInt(arg, 10);
  if (isNaN(num)) { u.send(`Usage: +event/cancel <#>`); return; }

  const raw = await getEventByNumber(num);
  if (!raw) { u.send(`${PREFIX} No event #${num} found.`); return; }
  const ev = normalizeEvent(raw);

  if (!isOwnerOrStaff(u, ev)) { u.send(`${PREFIX} Permission denied.`); return; }

  const updated: IGameEvent = { ...ev, status: "cancelled", updatedAt: Date.now() };
  await gameEvents.update({ id: ev.id }, updated);
  await eventHooks.emit("event:cancelled", updated);
  u.send(`${PREFIX} Event #${num} "${ev.title}" has been %ch%crcancelled%cn.`);
}

/** +event/delete <#> — staff or event creator. */
export async function handleDelete(u: IUrsamuSDK, arg: string): Promise<void> {
  const num = parseInt(arg, 10);
  if (isNaN(num)) { u.send(`Usage: +event/delete <#>`); return; }

  const raw = await getEventByNumber(num);
  if (!raw) { u.send(`${PREFIX} No event #${num} found.`); return; }
  const ev = normalizeEvent(raw);

  if (!isOwnerOrStaff(u, ev)) { u.send(`${PREFIX} Permission denied.`); return; }

  await gameEvents.delete({ id: ev.id });
  await import("../db.ts").then(m => m.eventRsvps.delete({ eventId: ev.id }));
  await eventHooks.emit("event:deleted", ev);
  u.send(`${PREFIX} Event #${num} deleted.`);
}
