# events-plugin — Claude Code Instructions

## Project identity

UrsaMU plugin: full-featured in-game event calendar with RSVPs, waitlists,
recurring series (cron), check-in, and approval workflow. Targets ursamu
`^2.3.0`.

- **Skill**: Load `/ursamu-dev` for ecosystem conventions before working here.
- **Engine API reference**: `/Users/kumakun/.claude/skills/ursamu-dev/references/api-reference.md` is authoritative for every type, method, import path, and event payload.
- **Plugin entry**: `index.ts` — registers commands (via `commands.ts`), wires hooks (`hooks.ts`), starts the reminder/series poller (`poller.ts`), and registers REST routes (`router.ts`).
- **Public API**: `mod.ts` — re-exports DBOs, hooks, config helpers, and types for downstream plugins.

---

## Pre-commit checklist (must pass before every commit)

```bash
deno check --unstable-kv index.ts          # type check (plugin entry)
deno lint                                    # lint clean
deno test --allow-all --unstable-kv --no-check tests/   # full suite
```

Run the same three steps for CI parity.

---

## Repo layout

```
index.ts             Plugin export — init() / remove(), addCmd registrations load here.
mod.ts               Public re-exports for other plugins to consume.
commands.ts          addCmd registrations for +event / +events (Phase 1, load-time).
commands/            Sub-command handlers (list, edit, rsvp, approval, series, shared).
router.ts            Express REST route dispatcher.
router/              Route helpers + handlers (events-crud, events-rsvp, series).
db.ts                DBO collections — namespaced events.*  (gameEvents, eventRsvps, …).
hooks.ts             Game-hook listeners (player:login → deliver pending notifications).
poller.ts            Reminder + series occurrence poller (started in init()).
config.ts            Plugin config get/update.
series.ts            cron parsing + next-occurrence helper.
types.ts             TS interfaces (IGameEvent, IEventRSVP, IEventSeries, …).
tests/               Deno test files — always place new tests here.
```

---

## Imports — always use JSR

```typescript
// All ursamu APIs come from the published package, never relative paths.
import {
  addCmd, DBO, dbojs, gameHooks, registerPluginRoute,
  resolveFormat, registerFormatHandler, unregisterFormatHandler,
} from "jsr:@ursamu/ursamu";
import type {
  ICmd, IPlugin, IDBObj, IUrsamuSDK, FormatSlot,
} from "jsr:@ursamu/ursamu";
```

`FormatSlot` is the engine-side literal union for built-in slots. For
plugin-defined slot names (e.g. `"EVENTLISTFORMAT"`, `"EVENTROWFORMAT"`) the
runtime accepts any string — cast at the call site: `slot as FormatSlot`.

---

## addCmd skeleton

```typescript
addCmd({
  name: "+example",
  pattern: /^\+example(?:\/(\S+))?\s*(.*)/i,   // args[0]=switch, args[1]=rest
  lock: "connected",
  category: "Events",
  help: `+example[/<switch>] <required> [<optional>]  — Brief description.

Switches:
  /switch   What this switch does.

Examples:
  +example Alice           Does the thing.
  +example/switch Alice    Does the other thing.`,
  exec: async (u: IUrsamuSDK) => {
    const sw  = (u.cmd.args[0] ?? "").toLowerCase().trim();
    const arg = u.util.stripSubs(u.cmd.args[1] ?? "").trim();
    // ...
  },
});
```

### Pattern cheat-sheet

| Intent | Pattern | args |
|--------|---------|------|
| No args | `/^inventory$/i` | — |
| One arg | `/^look\s+(.*)/i` | `[0]` |
| Switch + arg | `/^\+cmd(?:\/(\S+))?\s*(.*)/i` | `[0]`=sw, `[1]`=rest |
| Two parts (=) | `/^@name\s+(.+)=(.+)/i` | `[0]`, `[1]` |

### Catch-all switch gotcha

`+event` uses the catch-all switch pattern. Do **not** register a separate
`addCmd` for `+event/somesub` — the catch-all consumes it first. Handle every
sub-command as a switch branch inside the main `exec`.

### Lock levels

| String | Who can use it |
|--------|----------------|
| `""` | Login screen (unauthenticated) |
| `"connected"` | Any logged-in player |
| `"connected builder+"` | Builder flag or higher |
| `"connected admin+"` | Admin flag or higher |
| `"connected wizard"` | Wizard only |

### Lockfunc system

Lock strings support callable functions: `funcname(arg1, arg2)` combined with
`&&`, `||`, `!`, and `()` grouping.

Built-ins: `flag(name)`, `attr(name[,val])`, `type(name)`, `is(#id)`,
`holds(#id)`, `perm(level)`.

Register custom lockfuncs from this plugin's `init()`:

```typescript
import { registerLockFunc } from "jsr:@ursamu/ursamu";
registerLockFunc("rsvped", (enactor, _t, _args) =>
  // ... return boolean
  false
);
// lock: "connected && rsvped()"
```

Built-in names are protected. Locks fail-closed (unknown func → false).

---

## Format-attribute extension points

The plugin exposes two softcode-attribute slots on `+event/list`:

| Slot | Scope | `%0` |
|------|-------|------|
| `EVENTLISTFORMAT` | full block override | rendered default block |
| `EVENTROWFORMAT`  | per-row override    | one rendered default row |

Resolution order (matches WHO/WHOROW in the engine):

1. attribute on `#0` (game-wide skin)
2. attribute on the enactor (per-player skin)
3. plugin-registered handler (`registerFormatHandler`)
4. built-in default

Use the local `resolveGlobalFormat` helper in `commands/list.ts` for any new
list-style override.

---

## Key SDK idioms

```typescript
// Target resolution — always guard null
const target = await u.util.target(u.me, rawName, true);
if (!target) { u.send("Not found."); return; }

// Display name (applies monikers)
u.util.displayName(target, u.me);

// Strip MUSH codes BEFORE DB ops or length checks (always)
const clean = u.util.stripSubs(u.cmd.args[0]).trim();

// DB writes — op must be "$set" | "$inc" | "$unset" only
await gameEvents.modify({ id }, "$set",  { title: clean });
await counters.modify({ id: "eventid" }, "$inc", { value: 1 });

// Permission check (Promise<boolean>) — for objects you don't own
if (!(await u.canEdit(u.me, target))) { u.send("Permission denied."); return; }

// Admin / wizard check (Set-based)
const staff = u.me.flags.has("admin") || u.me.flags.has("wizard") || u.me.flags.has("superuser");

// Send to another player
u.send("Message for target.", target.id);
```

---

## MUSH color codes

| Code | Effect | Code | Effect |
|------|--------|------|--------|
| `%ch` | Bold | `%cn` | Reset (always close with this) |
| `%cr` | Red | `%cg` | Green |
| `%cb` | Blue | `%cy` | Yellow |
| `%cw` | White | `%cc` | Cyan |
| `%r`  | Newline | `%t` | Tab |

Use `u.util.center(title, 78, "=")` for section headers.

---

## Help file standards (non-negotiable)

Help text lives in the `help:` field of each `addCmd`. The help-plugin renders
these in-game; the same constraints apply as for plugin-side `.md` topics if
you ever add a `help/` directory.

### Width and length

- **Maximum line width: 78 characters** — headers, body, examples.
- **Maximum content lines per page: 22** (one terminal screen at 24 lines).
  Split topics that exceed.

### Format

```
+TOPIC-NAME

One-sentence description of what **+topic-name** does; use `value` for examples.

SYNTAX
  +command[/switch] <required> [<optional>]

SWITCHES
  /switch    What this switch does.

EXAMPLES
  +command foo       Does the thing.
  +command/switch x  Does the other thing.

SEE ALSO: +help related-topic
```

- Title `+TOPIC-NAME` ALL CAPS, flush left.
- Section labels ALL CAPS, flush left.
- Body indented 2 spaces.
- Exactly 1 blank line between sections.
- No line over 78 characters.

### Markdown in body text

Use subtle formatting that degrades to terminal color:
- `**bold**` → `%ch` — key terms, command names, important values.
- `` `backtick` `` → `%ch%cg` — inline code, slugs, paths, exact-match strings.
- **Do not use** `_italic_`, `### headings`, HTML, or tables.

---

## Plugin architecture (three phases — non-negotiable)

```
Phase 1 — module load   import "./commands.ts" → addCmd() fires at load time (NOT in init)
Phase 2 — init()        wire gameHooks listeners, registerPluginRoute, seed data → return true
Phase 3 — remove()      gameHooks.off() for every .on() using the SAME named function reference
```

```typescript
// index.ts
import "./commands.ts";                            // Phase 1
import { gameHooks } from "jsr:@ursamu/ursamu";
import type { IPlugin, SessionEvent } from "jsr:@ursamu/ursamu";

const onLogin = (e: SessionEvent) => { /* deliverPendingNotifications */ };

export const plugin: IPlugin = {
  name: "events",
  version: "2.1.0",
  description: "Event calendar with RSVP, waitlists, and recurring series.",
  init:   () => { gameHooks.on("player:login", onLogin); return true; },
  remove: () => { gameHooks.off("player:login", onLogin); },
};
```

**DBO namespace rule** — always prefix with `events.`:

```typescript
const gameEvents = new DBO<IGameEvent>("events.events");      // correct
const gameEvents = new DBO<IGameEvent>("events");              // wrong — collides
```

---

## Test patterns

### Required boilerplate

```typescript
// Any test that touches the service layer needs this — CmdParser triggers
// async file reads at init.
const OPTS = { sanitizeResources: false, sanitizeOps: false };
Deno.test("description", OPTS, async () => { /* ... */ });
```

### Real DB integration tests

This plugin uses real `dbojs` integration tests (no mock layer); follow the
pattern in `tests/events.test.ts`. Use stable, prefixed string IDs to avoid
collisions across test files (e.g. `"evp_player1"`, `"evt_fmt_1"`). For tests
that exercise softcode (`%0`, `iter`, dbref lookups), use **numeric** ids so
`#N` resolution works (e.g. `"910001"`).

### mockU helper for unit tests

When you don't need a real DB:

```typescript
import type { IDBObj, IUrsamuSDK } from "jsr:@ursamu/ursamu";

function mockPlayer(overrides: Partial<IDBObj> = {}): IDBObj {
  return {
    id: "test_actor1",
    name: "Tester",
    flags: new Set(["player", "connected"]),
    state: { name: "Tester" },
    location: "test_room1",
    contents: [],
    ...overrides,
  };
}

function mockU(opts: { args?: string[]; canEditResult?: boolean } = {}) {
  const sent: string[] = [];
  const dbCalls: unknown[][] = [];
  return Object.assign({
    me: mockPlayer(),
    here: { id: "test_room1", name: "Room", flags: new Set(["room"]), state: {}, contents: [], broadcast: () => {} },
    cmd: { name: "", original: "", args: opts.args ?? [], switches: [] },
    send: (m: string) => sent.push(m),
    broadcast: () => {},
    canEdit: async () => opts.canEditResult ?? true,
    util: {
      target: async () => null,
      displayName: (o: IDBObj) => o.name ?? "Unknown",
      stripSubs: (s: string) => s.replace(/%c[a-z]/gi, "").replace(/%[rntb]/gi, ""),
      center: (s: string) => s, ljust: (s: string, w: number) => s.padEnd(w), rjust: (s: string, w: number) => s.padStart(w),
    },
  } as unknown as IUrsamuSDK, { _sent: sent, _dbCalls: dbCalls });
}
```

### DB quirks

- `DBO.queryOne()` returns `T | undefined | false` — cast `as any` in tests when needed.
- Close DB in the last test of a file: `await DBO.close()`.

### Required test cases for every command

- Happy path — correct output and DB call.
- Null target / not-found — graceful message, no DB write.
- Permission denied — `canEdit` false or non-staff, no DB write.
- DB op is `$set` / `$inc` / `$unset` (assert exact args).
- Admin guard — non-admin rejected (if admin-only command).
- `stripSubs` called before DB on user input (MUSH codes stripped).

---

## Code style (non-negotiable)

- **Early return** over nested conditions.
- **No function longer than 50 lines** — decompose.
- **No file longer than 200 lines** — split.
- **No bare `catch`** — always `catch (e: unknown)`.
- **Library-first** — if the SDK does it, use the SDK.
- **No deep nesting** — max 3 levels.
- **No comments** unless the WHY is non-obvious.

---

## Audit checklist (run mentally before every PR)

- [ ] `u.util.stripSubs()` on all user strings before DB ops or length checks.
- [ ] `await u.canEdit(u.me, target)` before modifying any object not owned by `u.me`.
- [ ] All DB writes use `"$set"` / `"$inc"` / `"$unset"` — never raw object overwrite.
- [ ] `u.util.target()` result null-checked before use.
- [ ] Admin-only actions check `u.me.flags` explicitly.
- [ ] All `%c*` color codes closed with `%cn`.
- [ ] Every `addCmd` has `help:` with syntax line + Switches section (if switches) + ≥2 examples.
- [ ] `gameHooks.on()` in `init()` paired with `gameHooks.off()` in `remove()` — same named reference.
- [ ] DBO collection names prefixed with `events.`.
- [ ] REST route handlers return 401 before any work when `userId` is null.
- [ ] `init()` returns `true`.
- [ ] Custom lockfuncs registered via `registerLockFunc` — never overwrite built-in names.
- [ ] Format handlers registered with `registerFormatHandler` paired with `unregisterFormatHandler` in `remove()`.

---

## PRs and commits

- No Claude/AI attribution in PR titles, commit messages, or code comments.
- Use squash-merge for feature PRs.
- Tag versions after squash-merge: `git tag v<version> && git push --tags`.
