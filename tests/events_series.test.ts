/**
 * tests/events_series.test.ts
 *
 * Tests for:
 *  - cronNext() cron expression parser
 *  - ensureSeriesOccurrence() occurrence generation
 *  - REST: series CRUD (list, create, update)
 */
import { assertEquals, assertExists, assert } from "jsr:@std/assert";
import { cronNext, ensureSeriesOccurrence } from "../series.ts";
import { eventsRouteHandler } from "../router.ts";
import { eventSeries, gameEvents, counters } from "../db.ts";
import { dbojs } from "jsr:@ursamu/ursamu";
import type { IEventSeries } from "../types.ts";

const OPTS = { sanitizeResources: false, sanitizeOps: false };

const STAFF_ID  = "ser_staff1";
const PLAYER_ID = "ser_player1";

// ─── helpers ─────────────────────────────────────────────────────────────────

async function call<T>(
  method: string,
  path: string,
  userId: string | null,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const r = new Request(`http://localhost${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const res  = await eventsRouteHandler(r, userId);
  const data = (await res.json()) as T;
  return { status: res.status, data };
}

async function cleanAll() {
  const evs = await gameEvents.find({});
  for (const ev of evs) await gameEvents.delete({ id: ev.id }).catch(() => {});
  const srs = await eventSeries.find({});
  for (const s of srs) await eventSeries.delete({ id: s.id }).catch(() => {});
  await counters.delete({ id: "eventid" }).catch(() => {});
  await counters.delete({ id: "eventseries" }).catch(() => {});
  await dbojs.delete({ id: STAFF_ID }).catch(() => {});
  await dbojs.delete({ id: PLAYER_ID }).catch(() => {});
}

// ─── setup ───────────────────────────────────────────────────────────────────

Deno.test("EventsSeries — setup", OPTS, async () => {
  await cleanAll();
  await dbojs.create({ id: STAFF_ID,  flags: "player connected admin", data: { name: "Staff" } });
  await dbojs.create({ id: PLAYER_ID, flags: "player connected",       data: { name: "Player" } });
});

// ─── cronNext ─────────────────────────────────────────────────────────────────

Deno.test("EventsSeries — cronNext returns a future Date", OPTS, () => {
  const result = cronNext("0 20 * * 5", new Date()); // every Friday 20:00
  assertExists(result);
  assert(result instanceof Date);
  assert(result > new Date());
});

Deno.test("EventsSeries — cronNext handles every-minute expression", OPTS, () => {
  const after  = new Date();
  const result = cronNext("* * * * *", after);
  assertExists(result);
  // Should be exactly 1 minute after `after` (rounded to minute)
  assert(result.getTime() > after.getTime());
  assert(result.getTime() <= after.getTime() + 2 * 60_000);
});

Deno.test("EventsSeries — cronNext returns null for invalid expression", OPTS, () => {
  assertEquals(cronNext("not valid", new Date()), null);
  assertEquals(cronNext("* * * *", new Date()), null); // only 4 fields
});

Deno.test("EventsSeries — cronNext respects specific weekday", OPTS, () => {
  // "0 12 * * 1" = every Monday at noon
  const result = cronNext("0 12 * * 1", new Date());
  assertExists(result);
  assertEquals(result.getDay(), 1); // Monday
  assertEquals(result.getHours(), 12);
  assertEquals(result.getMinutes(), 0);
});

Deno.test("EventsSeries — cronNext handles step syntax", OPTS, () => {
  // "*/30 * * * *" = every 30 minutes
  const after  = new Date();
  const result = cronNext("*/30 * * * *", after);
  assertExists(result);
  assert(result.getMinutes() % 30 === 0);
});

Deno.test("EventsSeries — cronNext handles range syntax", OPTS, () => {
  // "0 9-17 * * *" = every hour from 9am-5pm
  const result = cronNext("0 9-17 * * *", new Date());
  assertExists(result);
  assert(result.getHours() >= 9 && result.getHours() <= 17);
});

// ─── ensureSeriesOccurrence ────────────────────────────────────────────────────

Deno.test("EventsSeries — ensureSeriesOccurrence generates upcoming event", OPTS, async () => {
  const series: IEventSeries = {
    id:              "test-series-1",
    number:          1,
    title:           "Weekly Test",
    description:     "Test series",
    cronExpression:  "0 20 * * 5", // every Friday 20:00
    durationMinutes: 60,
    tags:            ["test"],
    maxAttendees:    0,
    reminderMinutes: [30],
    active:          true,
    createdBy:       STAFF_ID,
    createdByName:   "Staff",
    createdAt:       Date.now(),
    updatedAt:       Date.now(),
  };

  await ensureSeriesOccurrence(series);

  const events = await gameEvents.find({ seriesId: "test-series-1" });
  assertEquals(events.length, 1);
  assertEquals(events[0].status, "upcoming");
  assertEquals(events[0].title, "Weekly Test");
  assertEquals(events[0].seriesId, "test-series-1");
  assertExists(events[0].endTime); // durationMinutes = 60
});

Deno.test("EventsSeries — ensureSeriesOccurrence does not duplicate if upcoming exists", OPTS, async () => {
  const series: IEventSeries = {
    id:              "test-series-1",
    number:          1,
    title:           "Weekly Test",
    description:     "Test series",
    cronExpression:  "0 20 * * 5",
    durationMinutes: 60,
    tags:            [], maxAttendees: 0, reminderMinutes: [],
    active:          true,
    createdBy:       STAFF_ID, createdByName: "Staff",
    createdAt:       Date.now(), updatedAt:   Date.now(),
  };

  await ensureSeriesOccurrence(series); // already has one

  const events = await gameEvents.find({ seriesId: "test-series-1" });
  assertEquals(events.length, 1); // still only one
});

// ─── REST series CRUD ─────────────────────────────────────────────────────────

Deno.test("EventsSeries — GET /api/v1/events/series 403 for player", OPTS, async () => {
  const { status } = await call("GET", "/api/v1/events/series", PLAYER_ID);
  assertEquals(status, 403);
});

Deno.test("EventsSeries — POST /api/v1/events/series creates series", OPTS, async () => {
  const { status, data } = await call<{ id: string; number: number; cronExpression: string }>(
    "POST", "/api/v1/events/series", STAFF_ID, {
      title:           "Daily Standup",
      description:     "Daily team check-in",
      cronExpression:  "0 9 * * 1-5", // weekdays at 9am
      durationMinutes: 30,
      reminderMinutes: [15],
    },
  );
  assertEquals(status, 201);
  assertEquals(data.cronExpression, "0 9 * * 1-5");
  assertExists(data.id);
  assertExists(data.number);
});

Deno.test("EventsSeries — POST /api/v1/events/series 400 for invalid cron", OPTS, async () => {
  const { status } = await call(
    "POST", "/api/v1/events/series", STAFF_ID, {
      title:          "Bad Series",
      description:    "D",
      cronExpression: "not a valid cron",
    },
  );
  assertEquals(status, 400);
});

Deno.test("EventsSeries — GET /api/v1/events/series staff sees all series", OPTS, async () => {
  const { status, data } = await call<{ id: string }[]>(
    "GET", "/api/v1/events/series", STAFF_ID,
  );
  assertEquals(status, 200);
  assert(Array.isArray(data));
  assert(data.length >= 1);
});

Deno.test("EventsSeries — PATCH /api/v1/events/series/:id updates cron", OPTS, async () => {
  const srs  = await eventSeries.find({});
  const series = srs[0];
  assertExists(series);

  const { status, data } = await call<{ cronExpression: string }>(
    "PATCH", `/api/v1/events/series/${series.number}`, STAFF_ID,
    { cronExpression: "0 18 * * 5" }, // change to 6pm Fridays
  );
  assertEquals(status, 200);
  assertEquals(data.cronExpression, "0 18 * * 5");
});

Deno.test("EventsSeries — PATCH series 400 for invalid cron update", OPTS, async () => {
  const srs  = await eventSeries.find({});
  const series = srs[0];

  const { status } = await call(
    "PATCH", `/api/v1/events/series/${series.number}`, STAFF_ID,
    { cronExpression: "bad cron" },
  );
  assertEquals(status, 400);
});

// ─── teardown ─────────────────────────────────────────────────────────────────

Deno.test("EventsSeries — teardown", OPTS, cleanAll);
