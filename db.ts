import { DBO } from "jsr:@ursamu/ursamu";
import type {
  IGameEvent, IEventRSVP, IEventSeries, IEventsConfig, IEventNotification,
} from "./types.ts";

export type { IGameEvent, IEventRSVP, IEventSeries, IEventsConfig, IEventNotification };

interface ICounters { id: string; seq: number; }

/** Shared counter store — used for sequential event and series numbers. */
export const counters          = new DBO<ICounters>("server.counters");

export const gameEvents        = new DBO<IGameEvent>("server.game-events");
export const eventRsvps        = new DBO<IEventRSVP>("server.event-rsvps");
export const eventSeries       = new DBO<IEventSeries>("server.event-series");
export const eventsConfig      = new DBO<IEventsConfig>("server.events-config");
export const eventNotifications = new DBO<IEventNotification>("server.events-notifications");

export function getNextEventNumber(): Promise<number> {
  return counters.atomicIncrement("eventid");
}

export function getNextSeriesNumber(): Promise<number> {
  return counters.atomicIncrement("eventseries");
}

/** Parse "YYYY-MM-DD" or "YYYY-MM-DD HH:MM" into a ms timestamp. Returns null on failure. */
export function parseDateTime(str: string): number | null {
  const normalized = str.trim().replace(" ", "T");
  const d = new Date(normalized);
  return isNaN(d.getTime()) ? null : d.getTime();
}

/** Format a ms timestamp for in-game display. */
export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

/**
 * Backfill v2 defaults on events that were created before the v2 fields existed.
 * Safe to call on any IGameEvent — already-correct fields are left untouched.
 */
export function normalizeEvent(ev: IGameEvent): IGameEvent {
  return {
    reminderMinutes: [],
    remindersSent:   [],
    playerCreated:   false,
    ...ev,
  };
}

/** Backfill v2 defaults on RSVPs created before the checkedIn field existed. */
export function normalizeRsvp(rsvp: IEventRSVP): IEventRSVP {
  return { checkedIn: false, ...rsvp };
}
