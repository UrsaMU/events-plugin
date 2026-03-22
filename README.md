# events-plugin

> In-game event calendar with RSVP tracking and REST API for UrsaMU.

## Commands

| Command | Syntax | Lock | Description |
|---------|--------|------|-------------|
| `+event` | `+event[/<switch>] [<args>]` | connected | Event calendar — list, view, RSVP, and staff management |
| `+events` | `+events` | connected | Alias for `+event/list` |

### Player switches

| Switch | Syntax | Description |
|--------|--------|-------------|
| `/list` | `+event/list` | List upcoming events (default) |
| `/view` | `+event/view <#>` | View event details + RSVP list |
| `/rsvp` | `+event/rsvp <#>[=attending\|maybe\|decline]` | RSVP to an event |
| `/unrsvp` | `+event/unrsvp <#>` | Cancel your RSVP |

### Staff switches

| Switch | Syntax | Description |
|--------|--------|-------------|
| `/create` | `+event/create <title>=<date>/<desc>` | Create a new event |
| `/edit` | `+event/edit <#>/<field>=<value>` | Edit a field |
| `/status` | `+event/status <#>=<status>` | Set status explicitly |
| `/cancel` | `+event/cancel <#>` | Cancel an event |
| `/delete` | `+event/delete <#>` | Permanently delete an event |

## REST Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/events` | Bearer | List events — supports `?status`, `?tag`, `?from`, `?to`, `?limit`, `?offset` |
| `POST` | `/api/v1/events` | Bearer (staff) | Create event |
| `GET` | `/api/v1/events/upcoming` | Bearer | Upcoming events shortcut |
| `GET` | `/api/v1/events/:id` | Bearer | Single event + RSVP summary |
| `PATCH` | `/api/v1/events/:id` | Bearer (staff) | Update event fields |
| `DELETE` | `/api/v1/events/:id` | Bearer (staff) | Delete event + RSVPs |
| `GET` | `/api/v1/events/:id/rsvps` | Bearer | Staff: full list; players: summary |
| `POST` | `/api/v1/events/:id/rsvp` | Bearer | RSVP or update RSVP |
| `DELETE` | `/api/v1/events/:id/rsvp` | Bearer | Cancel own RSVP |

## Hooks

Plugins can subscribe to event lifecycle hooks via `eventHooks`:

```ts
import { eventHooks } from "./mod.ts";

eventHooks.on("event:created", (ev) => {
  console.log(`New event #${ev.number}: ${ev.title}`);
});
```

| Hook | Payload | Fired when |
|------|---------|------------|
| `event:created` | `IGameEvent` | A new event is created |
| `event:updated` | `IGameEvent` | An event's details are changed |
| `event:cancelled` | `IGameEvent` | Status set to `cancelled` |
| `event:completed` | `IGameEvent` | Status set to `completed` |
| `event:deleted` | `IGameEvent` | An event is permanently deleted |
| `event:rsvp` | `IGameEvent, IEventRSVP` | A player RSVPs or updates their RSVP |
| `event:rsvp-cancelled` | `IGameEvent, IEventRSVP` | A player cancels their RSVP |

## Storage

| Collection | Schema | Purpose |
|------------|--------|---------|
| `server.game-events` | `IGameEvent` | Event records |
| `server.event-rsvps` | `IEventRSVP` | RSVP records |
| `server.counters` | `{ id, seq }` | Sequential event IDs |

## Install

Listed in `src/plugins/plugins.manifest.json` — auto-installed on next server start:

```json
{
  "name": "events",
  "url": "https://github.com/UrsaMU/events-plugin",
  "ref": "v1.0.0",
  "description": "In-game event calendar with RSVP tracking and REST API",
  "ursamu": ">=1.9.2"
}
```

## Requirements

- UrsaMU `>=1.9.2`
