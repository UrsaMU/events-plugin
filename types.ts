export type EventStatus = "pending" | "upcoming" | "active" | "completed" | "cancelled";
export type RsvpStatus  = "attending" | "maybe" | "declined" | "waitlist";

export interface IGameEvent {
  id: string;
  number: number;          // sequential in-game reference (#1, #2, ...)
  title: string;
  description: string;
  location?: string;
  startTime: number;       // ms timestamp
  endTime?: number;        // ms timestamp
  createdBy: string;       // player ID
  createdByName: string;
  status: EventStatus;
  tags: string[];
  maxAttendees: number;    // 0 = unlimited
  createdAt: number;
  updatedAt: number;

  // v2 fields
  reminderMinutes: number[];  // e.g. [60, 15] — minutes before startTime
  remindersSent: number[];    // offsets already fired (prevents double-send)
  seriesId?: string;          // ID of parent IEventSeries (recurring events)
  playerCreated: boolean;     // true when created by a non-staff player
}

export interface IEventRSVP {
  id: string;
  eventId: string;
  playerId: string;
  playerName: string;
  status: RsvpStatus;
  waitlistPosition?: number;  // 1-based; only set when status = "waitlist"
  checkedIn: boolean;         // true after physical check-in during active event
  checkedInAt?: number;       // ms timestamp of check-in
  note?: string;
  createdAt: number;
}

export interface IEventSeries {
  id: string;
  number: number;             // sequential reference
  title: string;
  description: string;
  location?: string;
  cronExpression: string;     // 5-field cron: "0 20 * * 5" = every Friday 8pm
  durationMinutes: number;    // 0 = no endTime generated
  tags: string[];
  maxAttendees: number;
  reminderMinutes: number[];
  active: boolean;            // false = paused (no new occurrences generated)
  createdBy: string;
  createdByName: string;
  createdAt: number;
  updatedAt: number;
}

/** Plugin-level config stored as a singleton in DB. */
export interface IEventsConfig {
  id: "config";
  requireApproval: boolean;   // player-created events require staff approval
  pollIntervalMs: number;     // background poller interval (default 60_000)
  maxPlayerEvents: number;    // max events a player can have open (0 = unlimited)
}

/** Queued in-game notification — delivered on next +event command or login. */
export interface IEventNotification {
  id: string;
  playerId: string;
  message: string;
  eventId: string;
  createdAt: number;
}
