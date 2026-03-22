import { gameEvents, getNextEventNumber } from "./db.ts";
import type { IEventSeries, IGameEvent } from "./types.ts";

// ─── cron parser ─────────────────────────────────────────────────────────────

/** Parse one cron field into its concrete set of matching values. */
function parseCronField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i++) values.add(i);
    } else if (part.startsWith("*/")) {
      const step = parseInt(part.slice(2), 10);
      if (step > 0) for (let i = min; i <= max; i += step) values.add(i);
    } else if (part.includes("-")) {
      const [a, b] = part.split("-").map(Number);
      for (let i = a; i <= b; i++) values.add(i);
    } else {
      const n = parseInt(part, 10);
      if (!isNaN(n)) values.add(n);
    }
  }

  return [...values].sort((a, b) => a - b);
}

/**
 * Calculate the next Date matching a 5-field cron expression after `after`.
 * Supports: `*`, `*\/n`, `n`, `a-b`, `a,b,c` per field.
 * Returns null if no match is found within 1 year.
 *
 * @param expr   Standard cron: "MIN HOUR DOM MONTH DOW"
 * @param after  Search starts from this point + 1 minute
 */
export function cronNext(expr: string, after: Date): Date | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const [minF, hourF, domF, monthF, dowF] = fields;
  const minutes = parseCronField(minF,   0, 59);
  const hours   = parseCronField(hourF,  0, 23);
  const doms    = parseCronField(domF,   1, 31);
  const months  = parseCronField(monthF, 1, 12);
  const dows    = parseCronField(dowF,   0,  6);

  // Start from the next whole minute after `after`
  const start = new Date(after.getTime() + 60_000);
  start.setSeconds(0, 0);
  const limit = new Date(after.getTime() + 366 * 24 * 60 * 60 * 1000);

  for (let d = new Date(start); d < limit; d = new Date(d.getTime() + 60_000)) {
    if (
      months.includes(d.getMonth() + 1) &&
      doms.includes(d.getDate())        &&
      dows.includes(d.getDay())         &&
      hours.includes(d.getHours())      &&
      minutes.includes(d.getMinutes())
    ) {
      return d;
    }
  }

  return null;
}

// ─── occurrence generation ────────────────────────────────────────────────────

/** Build an IGameEvent from a series template for the given start time. */
async function buildOccurrence(series: IEventSeries, startTime: number): Promise<IGameEvent> {
  const num = await getNextEventNumber();
  const now = Date.now();
  const endTime = series.durationMinutes > 0
    ? startTime + series.durationMinutes * 60_000
    : undefined;

  return {
    id:              `ev-${num}`,
    number:          num,
    title:           series.title,
    description:     series.description,
    location:        series.location,
    startTime,
    endTime,
    createdBy:       series.createdBy,
    createdByName:   series.createdByName,
    status:          "upcoming",
    tags:            [...series.tags],
    maxAttendees:    series.maxAttendees,
    reminderMinutes: [...series.reminderMinutes],
    remindersSent:   [],
    seriesId:        series.id,
    playerCreated:   false,
    createdAt:       now,
    updatedAt:       now,
  };
}

/**
 * Ensure the series has exactly one upcoming occurrence.
 * If none exists, calculate and create the next one via the cron expression.
 */
export async function ensureSeriesOccurrence(series: IEventSeries): Promise<void> {
  const existing   = await gameEvents.find({ seriesId: series.id });
  const hasLive    = existing.some(e => e.status === "upcoming" || e.status === "active");
  if (hasLive) return;

  const lastDone   = existing
    .filter(e => e.status === "completed" || e.status === "cancelled")
    .sort((a, b) => b.startTime - a.startTime)[0];

  // If no prior occurrences, generate from now; otherwise from after the last one
  const after      = lastDone ? new Date(lastDone.startTime) : new Date(Date.now() - 60_000);
  const nextDate   = cronNext(series.cronExpression, after);
  if (!nextDate) return;

  const occurrence = await buildOccurrence(series, nextDate.getTime());
  await gameEvents.create(occurrence);
}
