import { gameEvents, eventRsvps, eventSeries, eventNotifications } from "./db.ts";
import { eventHooks } from "./hooks.ts";
import { ensureSeriesOccurrence } from "./series.ts";
import type { IGameEvent } from "./types.ts";

const LOG = "[events] poller";

// ─── transition ───────────────────────────────────────────────────────────────

async function checkTransition(ev: IGameEvent, now: number): Promise<void> {
  if (ev.status === "upcoming" && ev.startTime <= now) {
    const updated = { ...ev, status: "active" as const, updatedAt: now };
    await gameEvents.update({ id: ev.id }, updated);
    await eventHooks.emit("event:updated", updated);
    return;
  }
  if (ev.status === "active" && ev.endTime && ev.endTime <= now) {
    const updated = { ...ev, status: "completed" as const, updatedAt: now };
    await gameEvents.update({ id: ev.id }, updated);
    await eventHooks.emit("event:completed", updated);
  }
}

async function transitionEvents(): Promise<void> {
  const now = Date.now();
  const all = await gameEvents.find({});
  for (const ev of all) await checkTransition(ev, now);
}

// ─── reminders ────────────────────────────────────────────────────────────────

async function checkEventReminders(ev: IGameEvent, now: number): Promise<void> {
  for (const offsetMin of (ev.reminderMinutes ?? [])) {
    if ((ev.remindersSent ?? []).includes(offsetMin)) continue;
    if (now < ev.startTime - offsetMin * 60_000) continue;

    // Mark sent atomically before delivery to prevent duplicate fires
    const sentList = [...(ev.remindersSent ?? []), offsetMin];
    await gameEvents.update({ id: ev.id }, { ...ev, remindersSent: sentList, updatedAt: now });

    const rsvps = await eventRsvps.find({ eventId: ev.id, status: "attending" });

    // Queue in-game notification for each RSVP'd player
    const label = offsetMin === 1 ? "1 minute" : `${offsetMin} minutes`;
    const msg   = `%ch%cy[EVENT REMINDER]%cn "${ev.title}" starts in ${label}.`;

    for (const rsvp of rsvps) {
      await eventNotifications.create({
        id:        crypto.randomUUID(),
        playerId:  rsvp.playerId,
        message:   msg,
        eventId:   ev.id,
        createdAt: now,
      });
    }

    await eventHooks.emit("event:reminder", ev, rsvps);
  }
}

async function fireReminders(): Promise<void> {
  const now = Date.now();
  const all = await gameEvents.find({});

  for (const ev of all) {
    if (ev.status !== "upcoming" && ev.status !== "active") continue;
    if (!(ev.reminderMinutes?.length)) continue;
    await checkEventReminders(ev, now);
  }
}

// ─── series ───────────────────────────────────────────────────────────────────

async function tickSeries(): Promise<void> {
  const active = await eventSeries.find({ active: true });
  for (const s of active) await ensureSeriesOccurrence(s);
}

// ─── main tick ────────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  await transitionEvents().catch(e => console.error(`${LOG} transition:`, e));
  await fireReminders().catch(e => console.error(`${LOG} reminders:`, e));
  await tickSeries().catch(e => console.error(`${LOG} series:`, e));
}

/** Start the background poller. Returns the interval handle for cleanup. */
export function startPoller(intervalMs: number): ReturnType<typeof setInterval> {
  return setInterval(() => void tick(), intervalMs);
}

/** Stop the background poller. */
export function stopPoller(id: ReturnType<typeof setInterval>): void {
  clearInterval(id);
}
