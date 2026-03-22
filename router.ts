import { isStaffUser, jsonResponse } from "./router/helpers.ts";
import { listEvents, createEvent, getEvent, updateEvent, deleteEvent } from "./router/events-crud.ts";
import {
  listRsvps, createRsvp, cancelRsvp, checkinRsvp, approveEvent,
} from "./router/events-rsvp.ts";
import { listSeries, createSeries, updateSeries } from "./router/series.ts";
import { getConfigRoute, updateConfigRoute } from "./router/config.ts";

/**
 * Main route handler for /api/v1/events.
 *
 * Routes:
 *   GET    /api/v1/events                      — list events (filterable)
 *   POST   /api/v1/events                      — create event
 *   GET    /api/v1/events/upcoming             — upcoming + active shortcut
 *   GET    /api/v1/events/config               — plugin config (staff)
 *   PATCH  /api/v1/events/config               — update config (staff)
 *   GET    /api/v1/events/series               — list series (staff)
 *   POST   /api/v1/events/series               — create series (staff)
 *   PATCH  /api/v1/events/series/:id           — edit series (staff)
 *   GET    /api/v1/events/:id                  — single event + RSVP summary
 *   PATCH  /api/v1/events/:id                  — update event (staff or creator)
 *   DELETE /api/v1/events/:id                  — delete event (staff or creator)
 *   GET    /api/v1/events/:id/rsvps            — RSVP list
 *   POST   /api/v1/events/:id/rsvp             — create/update RSVP
 *   DELETE /api/v1/events/:id/rsvp             — cancel RSVP
 *   POST   /api/v1/events/:id/checkin          — check in (self or staff/creator)
 *   PATCH  /api/v1/events/:id/approve          — approve pending event (staff)
 */
export async function eventsRouteHandler(
  req: Request,
  userId: string | null,
): Promise<Response> {
  if (!userId) return jsonResponse({ error: "Unauthorized" }, 401);

  const url    = new URL(req.url);
  const path   = url.pathname;
  const method = req.method;
  const staff  = await isStaffUser(userId);

  // ── collection-level routes ─────────────────────────────────────────────────
  if (path === "/api/v1/events" && method === "GET")  return listEvents(url, userId, staff);
  if (path === "/api/v1/events" && method === "POST") return createEvent(req, userId, staff);

  if (path === "/api/v1/events/upcoming" && method === "GET") {
    const now = Date.now();
    const res  = await listEvents(
      new URL(`${url.origin}/api/v1/events?status=upcoming&from=${now}`),
      userId, staff,
    );
    const body = await res.json() as { events: unknown[] };
    return jsonResponse(body.events);
  }

  // ── config ──────────────────────────────────────────────────────────────────
  if (path === "/api/v1/events/config") {
    if (!staff) return jsonResponse({ error: "Forbidden" }, 403);
    if (method === "GET")   return getConfigRoute();
    if (method === "PATCH") return updateConfigRoute(req);
  }

  // ── series ──────────────────────────────────────────────────────────────────
  if (path === "/api/v1/events/series" && method === "GET") {
    if (!staff) return jsonResponse({ error: "Forbidden" }, 403);
    return listSeries();
  }
  if (path === "/api/v1/events/series" && method === "POST") {
    if (!staff) return jsonResponse({ error: "Forbidden" }, 403);
    return createSeries(req, userId);
  }

  const seriesMatch = path.match(/^\/api\/v1\/events\/series\/([^/]+)$/);
  if (seriesMatch) {
    if (!staff) return jsonResponse({ error: "Forbidden" }, 403);
    if (method === "PATCH") return updateSeries(req, seriesMatch[1]);
  }

  // ── event by id/number sub-routes ───────────────────────────────────────────
  const evMatch = path.match(/^\/api\/v1\/events\/([^/]+)(\/[^/]+)?$/);
  if (evMatch) {
    const idParam = evMatch[1];
    const sub     = evMatch[2] || "";

    // Guard: "upcoming", "config", "series" are already handled above
    if (["upcoming", "config", "series"].includes(idParam)) {
      return jsonResponse({ error: "Not Found" }, 404);
    }

    if (!sub && method === "GET")    return getEvent(idParam, userId, staff);
    if (!sub && method === "PATCH")  return updateEvent(req, idParam, userId, staff);
    if (!sub && method === "DELETE") return deleteEvent(idParam, userId, staff);

    if (sub === "/rsvps"   && method === "GET")    return listRsvps(idParam, userId, staff);
    if (sub === "/rsvp"    && method === "POST")   return createRsvp(req, idParam, userId);
    if (sub === "/rsvp"    && method === "DELETE") return cancelRsvp(idParam, userId);
    if (sub === "/checkin" && method === "POST")   return checkinRsvp(req, idParam, userId, staff);
    if (sub === "/approve" && method === "PATCH") {
      if (!staff) return jsonResponse({ error: "Forbidden" }, 403);
      return approveEvent(idParam, userId);
    }
  }

  return jsonResponse({ error: "Not Found" }, 404);
}
