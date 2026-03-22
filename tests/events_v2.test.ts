/**
 * tests/events_v2.test.ts
 *
 * Tests for v2 features:
 *  - Player event creation → pending status
 *  - Approval and rejection workflow
 *  - Waitlist auto-assignment and slot promotion
 *  - Check-in (active-only gate)
 *  - Plugin config GET/PATCH
 *  - normalizeEvent / normalizeRsvp backfill helpers
 */
import { assertEquals, assertExists } from "jsr:@std/assert";
import { eventsRouteHandler } from "../router.ts";
import { gameEvents, eventRsvps, counters, eventsConfig, normalizeEvent, normalizeRsvp } from "../db.ts";
import { dbojs } from "jsr:@ursamu/ursamu";

const OPTS = { sanitizeResources: false, sanitizeOps: false };

const STAFF_ID   = "v2_staff1";
const PLAYER_ID  = "v2_player1";
const PLAYER2_ID = "v2_player2";
const PLAYER3_ID = "v2_player3";

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
  for (const ev of evs) {
    await gameEvents.delete({ id: ev.id }).catch(() => {});
    await eventRsvps.delete({ eventId: ev.id }).catch(() => {});
  }
  await counters.delete({ id: "eventid" }).catch(() => {});
  await eventsConfig.delete({ id: "config" }).catch(() => {});
  for (const id of [STAFF_ID, PLAYER_ID, PLAYER2_ID, PLAYER3_ID]) {
    await dbojs.delete({ id }).catch(() => {});
  }
}

// ─── setup ───────────────────────────────────────────────────────────────────

Deno.test("EventsV2 — setup fixtures", OPTS, async () => {
  await cleanAll();
  await dbojs.create({ id: STAFF_ID,   flags: "player connected admin", data: { name: "StaffUser" } });
  await dbojs.create({ id: PLAYER_ID,  flags: "player connected",       data: { name: "PlayerOne" } });
  await dbojs.create({ id: PLAYER2_ID, flags: "player connected",       data: { name: "PlayerTwo" } });
  await dbojs.create({ id: PLAYER3_ID, flags: "player connected",       data: { name: "PlayerThree" } });
});

// ─── normalizeEvent ────────────────────────────────────────────────────────────

Deno.test("EventsV2 — normalizeEvent fills v2 defaults", OPTS, () => {
  // Simulate a v1 event without v2 fields
  const v1Event = {
    id: "ev-1", number: 1, title: "Old", description: "D",
    startTime: Date.now(), createdBy: "1", createdByName: "T",
    status: "upcoming" as const, tags: [], maxAttendees: 0,
    createdAt: 0, updatedAt: 0,
  } as Parameters<typeof normalizeEvent>[0];

  const normalized = normalizeEvent(v1Event);
  assertEquals(normalized.reminderMinutes, []);
  assertEquals(normalized.remindersSent, []);
  assertEquals(normalized.playerCreated, false);
  assertEquals(normalized.title, "Old"); // existing fields preserved
});

// ─── normalizeRsvp ────────────────────────────────────────────────────────────

Deno.test("EventsV2 — normalizeRsvp fills checkedIn default", OPTS, () => {
  const v1Rsvp = {
    id: "r1", eventId: "e1", playerId: "p1", playerName: "P",
    status: "attending" as const, createdAt: 0,
  } as Parameters<typeof normalizeRsvp>[0];

  const normalized = normalizeRsvp(v1Rsvp);
  assertEquals(normalized.checkedIn, false);
  assertEquals(normalized.status, "attending");
});

// ─── player event creation → pending ─────────────────────────────────────────

Deno.test("EventsV2 — POST /api/v1/events player creates pending event", OPTS, async () => {
  // Set requireApproval = true (default)
  await eventsConfig.create({ id: "config", requireApproval: true, pollIntervalMs: 60_000, maxPlayerEvents: 10 });

  const { status, data } = await call<{ status: string; playerCreated: boolean; number: number }>(
    "POST", "/api/v1/events", PLAYER_ID, {
      title: "Player Event",
      description: "A player-created event",
      startTime: "2028-01-01 20:00",
    },
  );
  assertEquals(status, 201);
  assertEquals(data.status, "pending");
  assertEquals(data.playerCreated, true);
});

Deno.test("EventsV2 — pending event hidden from other players", OPTS, async () => {
  const { status, data } = await call<{ events: { status: string }[] }>(
    "GET", "/api/v1/events", PLAYER2_ID,
  );
  assertEquals(status, 200);
  const pending = (data.events || []).filter((e) => e.status === "pending");
  assertEquals(pending.length, 0);
});

Deno.test("EventsV2 — pending event visible to staff", OPTS, async () => {
  const { data } = await call<{ events: { status: string }[] }>(
    "GET", "/api/v1/events", STAFF_ID,
  );
  const pending = (data.events || []).filter((e) => e.status === "pending");
  assertEquals(pending.length >= 1, true);
});

// ─── approve ─────────────────────────────────────────────────────────────────

Deno.test("EventsV2 — PATCH /api/v1/events/:id/approve staff can approve", OPTS, async () => {
  const evs   = await gameEvents.find({ status: "pending" });
  const ev    = evs[0];
  assertExists(ev);

  const { status, data } = await call<{ status: string }>(
    "PATCH", `/api/v1/events/${ev.id}/approve`, STAFF_ID,
  );
  assertEquals(status, 200);
  assertEquals(data.status, "upcoming");
});

Deno.test("EventsV2 — PATCH /approve 403 for non-staff", OPTS, async () => {
  // Create another pending event to try to approve
  await eventsConfig.update({ id: "config" }, { id: "config", requireApproval: true, pollIntervalMs: 60_000, maxPlayerEvents: 10 });
  const { data: created } = await call<{ id: string }>(
    "POST", "/api/v1/events", PLAYER_ID, {
      title: "Another Pending",
      description: "Desc",
      startTime: "2028-06-01",
    },
  );
  const { status } = await call("PATCH", `/api/v1/events/${created.id}/approve`, PLAYER2_ID);
  assertEquals(status, 403);
});

// ─── waitlist auto-assignment ─────────────────────────────────────────────────

Deno.test("EventsV2 — RSVP attending when full auto-assigns to waitlist", OPTS, async () => {
  // Create a capped event via staff (status = upcoming)
  const { data: ev } = await call<{ id: string; number: number }>(
    "POST", "/api/v1/events", STAFF_ID, {
      title: "Capped Event",
      description: "Only 1 spot",
      startTime: "2028-03-01",
      maxAttendees: 1,
    },
  );

  // Player 1 takes the only spot
  const { status: s1 } = await call(
    "POST", `/api/v1/events/${ev.id}/rsvp`, PLAYER_ID,
    { status: "attending" },
  );
  assertEquals(s1, 201);

  // Player 2 gets auto-waitlisted
  const { status: s2, data: rsvp2 } = await call<{ status: string; waitlistPosition: number }>(
    "POST", `/api/v1/events/${ev.id}/rsvp`, PLAYER2_ID,
    { status: "attending" },
  );
  assertEquals(s2, 201);
  assertEquals(rsvp2.status, "waitlist");
  assertEquals(rsvp2.waitlistPosition, 1);
});

Deno.test("EventsV2 — cancelling attending RSVP promotes waitlisted player", OPTS, async () => {
  const evs = await gameEvents.find({ title: "Capped Event" });
  const ev  = evs[0];
  assertExists(ev);

  // Player 1 cancels
  const { status } = await call("DELETE", `/api/v1/events/${ev.id}/rsvp`, PLAYER_ID);
  assertEquals(status, 200);

  // Player 2 should now be attending
  const rsvp2 = await eventRsvps.queryOne({ eventId: ev.id, playerId: PLAYER2_ID });
  assertExists(rsvp2);
  assertEquals(rsvp2.status, "attending");
  assertEquals(rsvp2.waitlistPosition, undefined);
});

// ─── check-in ─────────────────────────────────────────────────────────────────

Deno.test("EventsV2 — POST /checkin rejects if event is not active", OPTS, async () => {
  const evs = await gameEvents.find({ status: "upcoming" });
  if (!evs.length) return; // skip if no upcoming events

  const ev = evs[0];
  // Player must have RSVP first
  await call("POST", `/api/v1/events/${ev.id}/rsvp`, PLAYER_ID, { status: "attending" });

  const { status } = await call("POST", `/api/v1/events/${ev.id}/checkin`, PLAYER_ID);
  assertEquals(status, 400); // not active
});

Deno.test("EventsV2 — POST /checkin succeeds on active event", OPTS, async () => {
  // Create an event and manually set it to active
  const { data: ev } = await call<{ id: string }>(
    "POST", "/api/v1/events", STAFF_ID, {
      title: "Active Checkin Test",
      description: "Test",
      startTime: "2028-04-01",
    },
  );

  // RSVP player
  await call("POST", `/api/v1/events/${ev.id}/rsvp`, PLAYER_ID, { status: "attending" });

  // Force event to active via PATCH
  await call("PATCH", `/api/v1/events/${ev.id}`, STAFF_ID, { status: "active" });

  // Check in
  const { status, data } = await call<{ checkedIn: boolean }>(
    "POST", `/api/v1/events/${ev.id}/checkin`, PLAYER_ID,
  );
  assertEquals(status, 200);
  assertEquals(data.checkedIn, true);
});

Deno.test("EventsV2 — POST /checkin rejects duplicate check-in", OPTS, async () => {
  const evs = await gameEvents.find({ title: "Active Checkin Test" });
  const ev  = evs[0];

  const { status } = await call("POST", `/api/v1/events/${ev.id}/checkin`, PLAYER_ID);
  assertEquals(status, 400); // already checked in
});

// ─── config ───────────────────────────────────────────────────────────────────

Deno.test("EventsV2 — GET /api/v1/events/config staff can read config", OPTS, async () => {
  const { status, data } = await call<{ requireApproval: boolean; pollIntervalMs: number }>(
    "GET", "/api/v1/events/config", STAFF_ID,
  );
  assertEquals(status, 200);
  assertExists(data.requireApproval);
  assertExists(data.pollIntervalMs);
});

Deno.test("EventsV2 — GET /api/v1/events/config 403 for player", OPTS, async () => {
  const { status } = await call("GET", "/api/v1/events/config", PLAYER_ID);
  assertEquals(status, 403);
});

Deno.test("EventsV2 — PATCH /api/v1/events/config staff can update", OPTS, async () => {
  const { status, data } = await call<{ requireApproval: boolean }>(
    "PATCH", "/api/v1/events/config", STAFF_ID,
    { requireApproval: false },
  );
  assertEquals(status, 200);
  assertEquals(data.requireApproval, false);
});

Deno.test("EventsV2 — player event goes live immediately when requireApproval=false", OPTS, async () => {
  const { status, data } = await call<{ status: string }>(
    "POST", "/api/v1/events", PLAYER_ID, {
      title: "Direct Event",
      description: "No approval needed",
      startTime: "2028-09-01",
    },
  );
  assertEquals(status, 201);
  assertEquals(data.status, "upcoming");
});

// ─── teardown ─────────────────────────────────────────────────────────────────

Deno.test("EventsV2 — teardown", OPTS, cleanAll);
