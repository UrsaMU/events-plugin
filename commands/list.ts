import type { IUrsamuSDK } from "jsr:@ursamu/ursamu";
import { gameEvents, eventRsvps, formatDateTime, normalizeEvent } from "../db.ts";
import { isStaff, statusColor, rsvpColor, getEventByNumber } from "./shared.ts";

const HEADER = "%ch+events%cn";
const PREFIX = "%ch+event:%cn";

// ─── list ─────────────────────────────────────────────────────────────────────

/** +event [/list] — List all visible events sorted by start time. */
export async function handleList(u: IUrsamuSDK): Promise<void> {
  const staff   = isStaff(u);
  const all     = await gameEvents.find({});

  const visible = all
    .map(normalizeEvent)
    .filter(e => {
      if (e.status === "cancelled") return staff;
      if (e.status === "pending")   return staff || e.createdBy === u.me.id;
      return true;
    })
    .sort((a, b) => a.startTime - b.startTime);

  if (!visible.length) {
    u.send(`${PREFIX} No upcoming events.`);
    return;
  }

  u.send(HEADER);
  u.send(
    "%ch" +
    u.util.rjust("#", 4) + "  " +
    u.util.ljust("Title", 28) +
    u.util.ljust("Date", 20) +
    u.util.rjust("RSVPs", 7) + "  " +
    "Status%cn",
  );
  u.send("%ch" + "-".repeat(70) + "%cn");

  for (const e of visible) {
    const attending  = await eventRsvps.find({ eventId: e.id, status: "attending" });
    const waitlisted = await eventRsvps.find({ eventId: e.id, status: "waitlist" });
    const capStr     = e.maxAttendees > 0
      ? `${attending.length}/${e.maxAttendees}${waitlisted.length ? `+${waitlisted.length}` : ""}`
      : String(attending.length);
    const sc         = statusColor(e.status);
    const pending    = e.status === "pending" ? " %ch%cx[PENDING]%cn" : "";

    u.send(
      u.util.rjust(String(e.number), 4) + "  " +
      u.util.ljust(e.title.slice(0, 27), 28) +
      u.util.ljust(formatDateTime(e.startTime), 20) +
      u.util.rjust(capStr, 7) + "  " +
      sc + e.status + "%cn" + pending,
    );
  }

  u.send('Use "+event/view <#>" to see details and RSVP.');
}

// ─── view ─────────────────────────────────────────────────────────────────────

/** +event/view <#> — Show full event details including RSVP lists. */
export async function handleView(u: IUrsamuSDK, arg: string): Promise<void> {
  const num = parseInt(arg, 10);
  if (isNaN(num)) { u.send(`Usage: +event/view <#>`); return; }

  const raw = await getEventByNumber(num);
  if (!raw) { u.send(`${PREFIX} No event #${num} found.`); return; }
  const ev  = normalizeEvent(raw);

  const staff = isStaff(u);
  if (ev.status === "pending" && !staff && ev.createdBy !== u.me.id) {
    u.send(`${PREFIX} No event #${num} found.`);
    return;
  }

  const sc = statusColor(ev.status);
  u.send(`%ch%cy+event #${ev.number}:%cn ${ev.title}`);
  u.send(`  Status  : ${sc}${ev.status}%cn${ev.playerCreated && staff ? " %ch%cx[player-created]%cn" : ""}`);
  u.send(`  Date    : ${formatDateTime(ev.startTime)}${ev.endTime ? " → " + formatDateTime(ev.endTime) : ""}`);
  if (ev.location)    u.send(`  Where   : ${ev.location}`);
  if (ev.tags.length) u.send(`  Tags    : ${ev.tags.join(", ")}`);
  if (ev.reminderMinutes.length) {
    u.send(`  Reminders: ${ev.reminderMinutes.map(m => `${m}m`).join(", ")} before start`);
  }
  u.send(`  Host    : ${ev.createdByName}`);
  u.send(`  Desc    : ${ev.description}`);

  const attending  = await eventRsvps.find({ eventId: ev.id, status: "attending" });
  const maybe      = await eventRsvps.find({ eventId: ev.id, status: "maybe" });
  const waitlist   = await eventRsvps.find({ eventId: ev.id, status: "waitlist" });
  const capStr     = ev.maxAttendees > 0 ? `/${ev.maxAttendees}` : "";

  u.send(`%ch  RSVPs:%cn ${attending.length}${capStr} attending, ${maybe.length} maybe, ${waitlist.length} waitlisted`);
  if (attending.length) u.send(`    Attending: ${attending.map(r => r.playerName).join(", ")}`);
  if (maybe.length)     u.send(`    Maybe    : ${maybe.map(r => r.playerName).join(", ")}`);
  if (waitlist.length)  u.send(`    Waitlist : ${waitlist.sort((a, b) => (a.waitlistPosition ?? 99) - (b.waitlistPosition ?? 99)).map(r => r.playerName).join(", ")}`);

  const myRsvp = await eventRsvps.queryOne({ eventId: ev.id, playerId: u.me.id });
  if (myRsvp) {
    const checkinStr = myRsvp.checkedIn ? " %ch%cg[CHECKED IN]%cn" : "";
    u.send(`  Your RSVP: ${rsvpColor(myRsvp.status)}${myRsvp.status}%cn${checkinStr}`);
  } else if (ev.status === "upcoming" || ev.status === "active") {
    u.send('  Use "+event/rsvp <#>" to RSVP.');
  }
}
