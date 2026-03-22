import type { IPlugin } from "jsr:@ursamu/ursamu";
import { registerPluginRoute, gameHooks } from "jsr:@ursamu/ursamu";
import type { SessionEvent } from "jsr:@ursamu/ursamu";
import { eventsRouteHandler } from "./router.ts";
import { eventNotifications } from "./db.ts";
import { getConfig } from "./config.ts";
import { startPoller, stopPoller } from "./poller.ts";
import "./commands.ts";

let _pollerId: ReturnType<typeof setInterval> | null = null;

// ─── player:login delivery ────────────────────────────────────────────────────

/**
 * On player login, emit any pending event notifications as page-like messages.
 * Notifications are cleared after being queued for delivery.
 *
 * Note: actual in-game socket delivery happens when the player next runs +event.
 * The login hook ensures the `event:reminder` hook fires for external plugins.
 */
async function onPlayerLogin({ actorId }: SessionEvent): Promise<void> {
  const pending = await eventNotifications.find({ playerId: actorId });
  if (!pending.length) return;

  // Emit each as a reminder hook so Discord bots / external plugins can act
  for (const n of pending) {
    await gameHooks.emit("events:notification" as never, {
      playerId: actorId,
      message:  n.message,
      eventId:  n.eventId,
    });
  }
  // Do NOT delete them here — they are delivered in-game when the player
  // next runs any +event command via deliverPendingNotifications().
}

// ─── plugin lifecycle ─────────────────────────────────────────────────────────

const eventsPlugin: IPlugin = {
  name:        "events",
  version:     "2.0.0",
  description: "In-game event calendar with RSVP, waitlist, check-in, recurring series, and REST API",

  init: async () => {
    registerPluginRoute("/api/v1/events", eventsRouteHandler);

    gameHooks.on("player:login", onPlayerLogin);

    const cfg = await getConfig();
    _pollerId = startPoller(cfg.pollIntervalMs);

    console.log(
      `[events] v2.0.0 initialized — poll interval: ${cfg.pollIntervalMs / 1000}s, ` +
      `requireApproval: ${cfg.requireApproval}`,
    );
    return true;
  },

  remove: () => {
    if (_pollerId !== null) {
      stopPoller(_pollerId);
      _pollerId = null;
    }
    gameHooks.off("player:login", onPlayerLogin);
    console.log("[events] Plugin removed");
  },
};

export default eventsPlugin;
