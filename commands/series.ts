import type { IUrsamuSDK } from "jsr:@ursamu/ursamu";
import { eventSeries, getNextSeriesNumber, formatDateTime } from "../db.ts";
import { eventHooks } from "../hooks.ts";
import type { IEventSeries } from "../types.ts";
import { isStaff, getPlayerName } from "./shared.ts";
import { cronNext } from "../series.ts";

const PREFIX = "%ch+event:%cn";

// ─── series list ─────────────────────────────────────────────────────────────

/** +event/series — List all recurring series (staff only). */
export async function handleSeriesList(u: IUrsamuSDK): Promise<void> {
  if (!isStaff(u)) { u.send(`${PREFIX} Permission denied.`); return; }

  const all = await eventSeries.find({});
  if (!all.length) { u.send(`${PREFIX} No recurring series defined.`); return; }

  u.send("%ch+event series%cn");
  u.send(
    "%ch" +
    u.util.rjust("#", 4) + "  " +
    u.util.ljust("Title", 28) +
    u.util.ljust("Cron", 15) +
    u.util.rjust("Next", 20) + "  " +
    "State%cn",
  );
  u.send("%ch" + "-".repeat(72) + "%cn");

  for (const s of all.sort((a, b) => a.number - b.number)) {
    const next    = cronNext(s.cronExpression, new Date());
    const nextStr = next ? formatDateTime(next.getTime()) : "—";
    const state   = s.active ? "%ch%cgactive%cn" : "%ch%cxpaused%cn";

    u.send(
      u.util.rjust(String(s.number), 4) + "  " +
      u.util.ljust(s.title.slice(0, 27), 28) +
      u.util.ljust(s.cronExpression, 15) +
      u.util.rjust(nextStr, 20) + "  " +
      state,
    );
  }
}

// ─── series create ────────────────────────────────────────────────────────────

/** +event/series-create <title>=<cron>/<desc> — staff only. */
export async function handleSeriesCreate(u: IUrsamuSDK, arg: string): Promise<void> {
  if (!isStaff(u)) { u.send(`${PREFIX} Permission denied.`); return; }

  const eqIdx = arg.indexOf("=");
  if (eqIdx === -1) { u.send(`Usage: +event/series-create <title>=<cron-expr>/<description>`); return; }

  // stripSubs before storing — MUSH codes must not land in series titles
  const title = u.util.stripSubs(arg.slice(0, eqIdx)).trim();
  const rest  = arg.slice(eqIdx + 1);
  // cron is 5 whitespace-separated tokens; find the "/" separating cron from desc
  // Format: "<m h d m dow>/<description>"
  const cronMatch = rest.match(/^((?:\S+\s+){4}\S+)\s*\/\s*([\s\S]+)$/);

  if (!cronMatch) {
    u.send(`${PREFIX} Usage: +event/series-create <title>=<m h dom month dow>/<description>`);
    u.send(`${PREFIX} Example: +event/series-create Trivia Night=0 20 * * 5/Weekly trivia every Friday.`);
    return;
  }

  const cron = cronMatch[1].trim();
  // stripSubs before storing — MUSH codes must not land in descriptions
  const desc = u.util.stripSubs(cronMatch[2]).trim();

  if (!cronNext(new Date(cron), new Date())) {
    // Validate by trying to parse (cronNext returns null for bad expressions)
    const test = cronNext(cron, new Date());
    if (!test) {
      u.send(`${PREFIX} Invalid cron expression "${cron}". Use standard 5-field format.`);
      return;
    }
  }

  const num        = await getNextSeriesNumber();
  const playerName = await getPlayerName(u.me.id);
  const now        = Date.now();

  const series: IEventSeries = {
    id:              `series-${num}`,
    number:          num,
    title,
    description:     desc,
    cronExpression:  cron,
    durationMinutes: 0,
    tags:            [],
    maxAttendees:    0,
    reminderMinutes: [60, 15],
    active:          true,
    createdBy:       u.me.id,
    createdByName:   playerName,
    createdAt:       now,
    updatedAt:       now,
  };

  await eventSeries.create(series);
  await eventHooks.emit("event:series-created", series);
  u.send(`${PREFIX} Series #${num} "${title}" created (cron: ${cron}).`);
}

// ─── series edit ──────────────────────────────────────────────────────────────

/** +event/series-edit <#>/<field>=<value> — staff only. */
export async function handleSeriesEdit(u: IUrsamuSDK, arg: string): Promise<void> {
  if (!isStaff(u)) { u.send(`${PREFIX} Permission denied.`); return; }

  const slash = arg.indexOf("/");
  const eq    = arg.indexOf("=");
  if (slash === -1 || eq === -1 || eq < slash) {
    u.send(`Usage: +event/series-edit <#>/<field>=<value>`);
    return;
  }

  const num   = parseInt(arg.slice(0, slash).trim(), 10);
  const field = arg.slice(slash + 1, eq).trim().toLowerCase();
  // stripSubs before storing — MUSH codes must not land in series fields
  const value = u.util.stripSubs(arg.slice(eq + 1)).trim();
  if (isNaN(num)) { u.send(`Usage: +event/series-edit <#>/<field>=<value>`); return; }

  const series = await eventSeries.queryOne({ number: num });
  if (!series) { u.send(`${PREFIX} No series #${num} found.`); return; }

  const update: Partial<IEventSeries> = { updatedAt: Date.now() };
  const FIELDS = "title, description, location, cron, duration, maxattendees, tags, reminders";

  switch (field) {
    case "title":        update.title           = value; break;
    case "description":  update.description     = value; break;
    case "location":     update.location        = value; break;
    case "cron":         { const t = cronNext(value, new Date()); if (!t) { u.send(`${PREFIX} Invalid cron expression.`); return; } update.cronExpression = value; break; }
    case "duration":     { const n = parseInt(value, 10); if (isNaN(n) || n < 0) { u.send(`${PREFIX} duration must be ≥ 0 minutes.`); return; } update.durationMinutes = n; break; }
    case "maxattendees": { const n = parseInt(value, 10); if (isNaN(n) || n < 0) { u.send(`${PREFIX} maxattendees must be ≥ 0.`); return; } update.maxAttendees = n; break; }
    case "tags":         update.tags             = value.split(",").map(t => t.trim()).filter(Boolean); break;
    case "reminders":    update.reminderMinutes  = value.split(",").map(m => parseInt(m.trim(), 10)).filter(n => !isNaN(n) && n > 0); break;
    default:
      u.send(`${PREFIX} Unknown field "${field}". Valid: ${FIELDS}`);
      return;
  }

  await eventSeries.update({ id: series.id }, { ...series, ...update });
  u.send(`${PREFIX} Series #${num} updated (${field}).`);
}

// ─── series pause ─────────────────────────────────────────────────────────────

/** +event/series-pause <#> — toggle active/paused (staff only). */
export async function handleSeriesPause(u: IUrsamuSDK, arg: string): Promise<void> {
  if (!isStaff(u)) { u.send(`${PREFIX} Permission denied.`); return; }

  const num = parseInt(arg, 10);
  if (isNaN(num)) { u.send(`Usage: +event/series-pause <#>`); return; }

  const series = await eventSeries.queryOne({ number: num });
  if (!series) { u.send(`${PREFIX} No series #${num} found.`); return; }

  const updated: IEventSeries = { ...series, active: !series.active, updatedAt: Date.now() };
  await eventSeries.update({ id: series.id }, updated);

  const state = updated.active ? "%ch%cgactive%cn" : "%ch%cxpaused%cn";
  u.send(`${PREFIX} Series #${num} "${series.title}" is now ${state}.`);
}
