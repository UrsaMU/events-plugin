# events-plugin

> Full-featured in-game event calendar with RSVP tracking, recurring series, waitlists, check-in, player-created events, and a REST API — for UrsaMU.

## Commands

| Command | Syntax | Lock | Description |
|---------|--------|------|-------------|
| `+event` | `+event[/<switch>] [<args>]` | connected | Event calendar — all switches below |
| `+events` | `+events` | connected | Alias for `+event/list` |

### Player switches

| Switch | Syntax | Description |
|--------|--------|-------------|
| `/list` | `+event/list` | List upcoming events (default) |
| `/view` | `+event/view <#>` | View event details, RSVP list, and waitlist |
| `/rsvp` | `+event/rsvp <#>[=attending\|maybe\|decline]` | RSVP to an event; auto-waitlists if full |
| `/unrsvp` | `+event/unrsvp <#>` | Cancel your RSVP; promotes first waitlist entry |
| `/checkin` | `+event/checkin <#>` | Self check-in to an **active** event |
| `/create` | `+event/create <title>=<date>/<desc>` | Create a player event (pending approval if required) |

### Staff switches

| Switch | Syntax | Description |
|--------|--------|-------------|
| `/create` | `+event/create <title>=<date>/<desc>` | Create event (immediately `upcoming`) |
| `/edit` | `+event/edit <#>/<field>=<value>` | Edit a field on any event |
| `/status` | `+event/status <#>=<status>` | Set status explicitly |
| `/cancel` | `+event/cancel <#>` | Cancel an event |
| `/delete` | `+event/delete <#>` | Permanently delete an event + RSVPs |
| `/approve` | `+event/approve <#>` | Approve a pending player event |
| `/reject` | `+event/reject <#>` | Reject and delete a pending player event |
| `/checkin` | `+event/checkin <#>=<player>` | Check in a named player (staff or organizer) |
| `/series` | `+event/series` | List all recurring series |
| `/series/create` | `+event/series/create <title>=<cron>/<desc>` | Create a recurring series |
| `/series/edit` | `+event/series/edit <#>/<field>=<value>` | Edit a series field |
| `/series/pause` | `+event/series/pause <#>` | Toggle series active/paused |

## Event Lifecycle

```
[player creates]  →  pending  ──(staff approves)──→  upcoming
[staff creates]   →  upcoming ──(startTime reached)─→ active
                            ──(endTime reached)──→  completed
                            ──(staff cancels)────→  cancelled
```

Auto-transitions are handled by a background poller (interval configurable via `/config`).

## Recurring Series

Staff can define cron-based recurring event series. A new `upcoming` occurrence is
automatically generated whenever the previous one transitions to `active` or `completed`.

```
Cron format: <minute> <hour> <day-of-month> <month> <day-of-week>

Examples:
  0 20 * * 5      Every Friday at 8 pm
  0 9 * * 1-5     Weekdays at 9 am
  */30 * * * *    Every 30 minutes
  0 18 1,15 * *   1st and 15th of each month at 6 pm
```

## Reminders

Events support per-event configurable reminder windows via `reminderMinutes: number[]`.
When a reminder window is reached, all attending RSVPs receive an in-game notification and
the `event:reminder` hook fires for external integrations (Discord bots, etc.).

Notifications queued while a player is offline are delivered the next time they run any
`+event` command.

## REST Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/events` | Bearer | List events — `?status`, `?tag`, `?from`, `?to`, `?limit`, `?offset` |
| `POST` | `/api/v1/events` | Bearer | Create event (player → pending if requireApproval; staff → upcoming) |
| `GET` | `/api/v1/events/upcoming` | Bearer | Upcoming events shortcut — returns plain array |
| `GET` | `/api/v1/events/config` | Bearer (staff) | Read plugin config |
| `PATCH` | `/api/v1/events/config` | Bearer (staff) | Update plugin config |
| `GET` | `/api/v1/events/series` | Bearer (staff) | List all recurring series |
| `POST` | `/api/v1/events/series` | Bearer (staff) | Create a recurring series |
| `PATCH` | `/api/v1/events/series/:id` | Bearer (staff) | Edit a series |
| `GET` | `/api/v1/events/:id` | Bearer | Single event + RSVP summary (`attendingCount`, `myRsvp`, `waitlistQueue`) |
| `PATCH` | `/api/v1/events/:id` | Bearer (staff or creator) | Update event fields |
| `DELETE` | `/api/v1/events/:id` | Bearer (staff or creator) | Delete event + all RSVPs |
| `GET` | `/api/v1/events/:id/rsvps` | Bearer | RSVP list (staff: full; player: summary) |
| `POST` | `/api/v1/events/:id/rsvp` | Bearer | RSVP or update; auto-waitlists when at capacity |
| `DELETE` | `/api/v1/events/:id/rsvp` | Bearer | Cancel own RSVP; promotes first waitlist entry |
| `POST` | `/api/v1/events/:id/checkin` | Bearer | Check in (self, or staff/creator for named player) |
| `PATCH` | `/api/v1/events/:id/approve` | Bearer (staff) | Approve a pending event → upcoming |

### `GET /api/v1/events/:id` response shape

```json
{
  "id": "ev-1",
  "number": 1,
  "title": "Grand Tournament",
  "status": "upcoming",
  "startTime": 1234567890000,
  "endTime": 1234571490000,
  "attendingCount": 3,
  "maybeCount": 1,
  "waitlistCount": 2,
  "checkinCount": 0,
  "myRsvp": "attending",
  "attendees": [{ "id": "p1", "name": "Alice", "checkedIn": false }],
  "waitlistQueue": [{ "id": "p4", "name": "Dave", "position": 1 }]
}
```

## Hooks

```ts
import { eventHooks } from "./mod.ts";

eventHooks.on("event:reminder", (ev, rsvps) => {
  // send Discord notification
});
```

| Hook | Payload | Fired when |
|------|---------|------------|
| `event:created` | `IGameEvent` | A new event is created |
| `event:updated` | `IGameEvent` | An event's details change |
| `event:cancelled` | `IGameEvent` | Status set to `cancelled` |
| `event:completed` | `IGameEvent` | Status set to `completed` |
| `event:deleted` | `IGameEvent` | Event permanently deleted |
| `event:approved` | `IGameEvent` | Pending event approved by staff |
| `event:rsvp` | `IGameEvent, IEventRSVP` | Player RSVPs or updates RSVP |
| `event:rsvp-cancelled` | `IGameEvent, IEventRSVP` | Player cancels RSVP |
| `event:reminder` | `IGameEvent, IEventRSVP[]` | Reminder window reached for attending players |
| `event:waitlist-promoted` | `IGameEvent, IEventRSVP` | Waitlisted player promoted to attending |
| `event:checkin` | `IGameEvent, IEventRSVP` | Player checked in |
| `event:series-created` | `IEventSeries` | New recurring series created |

## Storage

| Collection | Schema | Purpose |
|------------|--------|---------|
| `server.game-events` | `IGameEvent` | Event records |
| `server.event-rsvps` | `IEventRSVP` | RSVP records (includes `waitlistPosition`, `checkedIn`) |
| `server.event-series` | `IEventSeries` | Recurring series definitions |
| `server.events-config` | `IEventsConfig` | Plugin configuration |
| `server.event-notifications` | `IEventNotification` | Queued offline notifications |
| `server.counters` | `{ id, seq }` | Sequential IDs for events and series |

## Configuration

Managed via `PATCH /api/v1/events/config` (staff only) or via `+event/config`:

| Key | Default | Description |
|-----|---------|-------------|
| `requireApproval` | `true` | Player-created events go to `pending` if true |
| `pollIntervalMs` | `60000` | Poller tick rate (ms); restart required to take effect |
| `maxPlayerEvents` | `10` | Max open events a single player may own at once (0 = unlimited) |

## Install

Listed in `src/plugins/plugins.manifest.json` — auto-installed on next server start:

```json
{
  "name": "events",
  "url": "https://github.com/UrsaMU/events-plugin",
  "ref": "v2.0.0",
  "description": "Full-featured event calendar with RSVP, waitlists, recurring series, and check-in",
  "ursamu": ">=1.9.2"
}
```

## Requirements

- UrsaMU `>=1.9.2`
