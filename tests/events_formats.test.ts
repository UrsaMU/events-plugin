/**
 * Integration test: @eventlistformat / @eventrowformat evaluated through the
 * REAL TinyMUX softcode engine via resolveFormat (mirrors ursamu's
 * tests/look_formats_integration.test.ts).
 *
 * Numeric ids are used so softcode #N dbref resolution works.
 *   %0 in @eventlistformat = full default block.
 *   %0 in @eventrowformat  = one default row.
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import {
  dbojs, DBO,
  registerFormatHandler, unregisterFormatHandler,
} from "jsr:@ursamu/ursamu";
import { handleList } from "../commands/list.ts";
import { gameEvents, eventRsvps, counters, eventsConfig } from "../db.ts";
import type { IGameEvent } from "../types.ts";

const OPTS = { sanitizeResources: false, sanitizeOps: false };
const SLOW = { timeout: 15000 };

// Numeric ids (string form) so #N softcode dbref resolution works.
const ROOT  = "0";
const ROOM  = "910001";
const ACTOR = "910002";

async function cleanup() {
  const evs = await gameEvents.find({});
  for (const ev of evs) {
    await gameEvents.delete({ id: ev.id }).catch(() => {});
    await eventRsvps.delete({ eventId: ev.id }).catch(() => {});
  }
  await counters.delete({ id: "eventid" }).catch(() => {});
  await eventsConfig.delete({ id: "config" }).catch(() => {});
  for (const id of [ROOT, ROOM, ACTOR]) {
    await dbojs.delete({ id }).catch(() => {});
  }
}

type Attr = { name: string; value: string; setter: string; type: string };

async function seedRoot(attrs: Record<string, string> = {}) {
  const attributes: Attr[] = Object.entries(attrs).map(([name, value]) => ({
    name: name.toUpperCase(), value, setter: ROOT, type: "attribute",
  }));
  await dbojs.create({
    id: ROOT,
    flags: "thing",
    data: { name: "GameRoot", attributes },
  });
}

async function seedActor(attrs: Record<string, string> = {}) {
  const attributes: Attr[] = Object.entries(attrs).map(([name, value]) => ({
    name: name.toUpperCase(), value, setter: ACTOR, type: "attribute",
  }));
  await dbojs.create({
    id: ROOM,
    flags: "room",
    data: { name: "EvtFmt Room" },
  });
  await dbojs.create({
    id: ACTOR,
    flags: "player connected wizard",
    data: { name: "Alice", attributes },
    location: ROOM,
  });
}

function makeEvent(overrides: Partial<IGameEvent>): IGameEvent {
  const now = Date.now();
  return {
    id: "evt_fmt_x",
    number: 0,
    title: "Untitled",
    description: "—",
    location: "Lounge",
    startTime: now + 3600_000,
    endTime: 0,
    createdBy: ACTOR,
    createdByName: "Alice",
    status: "upcoming",
    tags: [],
    maxAttendees: 0,
    createdAt: now,
    updatedAt: now,
    reminderMinutes: [],
    remindersSent: [],
    playerCreated: false,
    ...overrides,
  };
}

async function seedEvents() {
  const now = Date.now();
  await gameEvents.create(makeEvent({
    id: "evt_fmt_1", number: 101, title: "Trivia Night",
    description: "Weekly trivia.", startTime: now + 3600_000,
  }));
  await gameEvents.create(makeEvent({
    id: "evt_fmt_2", number: 102, title: "Movie Night",
    description: "Group movie.", startTime: now + 7200_000,
  }));
}

// ─── Minimal SDK builder ─────────────────────────────────────────────────────
// We don't need a full createNativeSDK — handleList only touches a tiny slice
// of IUrsamuSDK plus u.attr.get (which resolveFormat reads). attr.get mirrors
// the real native SDK implementation.

function buildU(sent: string[]) {
  const attrGet = async (id: string, name: string): Promise<string | null> => {
    const obj = await dbojs.queryOne({ id });
    if (!obj) return null;
    const attrs = (obj.data?.attributes as Array<{ name: string; value: string }> | undefined) || [];
    const found = attrs.find(a => a.name.toUpperCase() === name.toUpperCase());
    return found?.value ?? null;
  };

  const me = {
    id: ACTOR,
    name: "Alice",
    flags: new Set(["player", "connected", "wizard"]),
    state: { name: "Alice" },
    location: ROOM,
    contents: [],
  };

  return {
    me,
    here: { id: ROOM, name: "EvtFmt Room", flags: new Set(["room"]), state: {}, contents: [] },
    cmd:  { name: "+event", original: "+event", args: ["list", ""], switches: [] },
    socketId: "evtfmt-sock",
    send: (m: string) => { sent.push(m); },
    broadcast: () => {},
    canEdit: () => Promise.resolve(true),
    util: {
      stripSubs: (s: string) => s.replace(/%c[a-z]/gi, "").replace(/%[rntbR]/gi, ""),
      ljust: (s: string, w: number) => s.padEnd(w),
      rjust: (s: string, w: number) => s.padStart(w),
      center: (s: string) => s,
      displayName: (o: { name?: string }) => o.name ?? "Unknown",
      target: () => Promise.resolve(null),
    },
    attr: { get: attrGet },
    db: {
      modify: () => Promise.resolve(),
      search: () => Promise.resolve([]),
      create: (d: unknown) => Promise.resolve(d),
      destroy: () => Promise.resolve(),
    },
    // deno-lint-ignore no-explicit-any
  } as any;
}

async function runList(): Promise<string> {
  const sent: string[] = [];
  await handleList(buildU(sent));
  return sent.join("\n");
}

// ─── Tests ───────────────────────────────────────────────────────────────────

Deno.test("events fmt: no attrs — default rendering", { ...OPTS, ...SLOW }, async () => {
  await cleanup();
  await seedActor();
  await seedEvents();
  const out = await runList();
  assertStringIncludes(out, "Trivia Night");
  assertStringIncludes(out, "Movie Night");
  assertStringIncludes(out, "+events");
  assertStringIncludes(out, 'Use "+event/view <#>"');
  await cleanup();
});

Deno.test("events fmt: @eventlistformat block override — %0 wraps default", { ...OPTS, ...SLOW }, async () => {
  await cleanup();
  await seedActor({ EVENTLISTFORMAT: ">>>BLOCK<<<%r%0%r>>>END<<<" });
  await seedEvents();
  const out = await runList();
  assertStringIncludes(out, ">>>BLOCK<<<");
  assertStringIncludes(out, ">>>END<<<");
  // %0 inside override still contains the default content (rendered rows).
  assertStringIncludes(out, "Trivia Night");
  await cleanup();
});

Deno.test("events fmt: @eventrowformat per-row override", { ...OPTS, ...SLOW }, async () => {
  await cleanup();
  await seedActor({ EVENTROWFORMAT: "<<ROW:%0>>" });
  await seedEvents();
  const out = await runList();
  // Each event row is wrapped; we should see <<ROW:...>> wrapping each title.
  assertStringIncludes(out, "<<ROW:");
  assertStringIncludes(out, "Trivia Night");
  assertStringIncludes(out, "Movie Night");
  // Both rows wrapped — at least two <<ROW: markers.
  const matches = out.match(/<<ROW:/g) ?? [];
  assertEquals(matches.length >= 2, true, `expected >=2 <<ROW: markers, got ${matches.length}`);
  await cleanup();
});

Deno.test("events fmt: priority — #0 attr wins over enactor attr", { ...OPTS, ...SLOW }, async () => {
  await cleanup();
  await seedRoot({ EVENTLISTFORMAT: "ROOT-WINS:%0" });
  await seedActor({ EVENTLISTFORMAT: "ACTOR-LOSES:%0" });
  await seedEvents();
  const out = await runList();
  assertStringIncludes(out, "ROOT-WINS:");
  assertEquals(out.includes("ACTOR-LOSES:"), false);
  await cleanup();
});

Deno.test("events fmt: priority — plugin handler runs when no attr set", { ...OPTS, ...SLOW }, async () => {
  await cleanup();
  await seedActor();
  await seedEvents();
  // deno-lint-ignore no-explicit-any
  const handler = (_u: any, _t: any, arg: string) => `PLUGIN[${arg.split("\n")[0]}]`;
  // Slot name isn't in the FormatSlot literal union — cast.
  // deno-lint-ignore no-explicit-any
  registerFormatHandler("EVENTLISTFORMAT" as any, handler);
  try {
    const out = await runList();
    assertStringIncludes(out, "PLUGIN[");
  } finally {
    // deno-lint-ignore no-explicit-any
    unregisterFormatHandler("EVENTLISTFORMAT" as any, handler);
    await cleanup();
    await DBO.close();
  }
});
