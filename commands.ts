import { addCmd } from "jsr:@ursamu/ursamu";
import type { IUrsamuSDK } from "jsr:@ursamu/ursamu";
import { handleList, handleView } from "./commands/list.ts";
import { handleRsvp, handleUnrsvp, handleCheckin } from "./commands/rsvp.ts";
import { handleCreate, handleEdit, handleStatus, handleCancel, handleDelete } from "./commands/edit.ts";
import { handleApprove, handleReject } from "./commands/approval.ts";
import {
  handleSeriesList, handleSeriesCreate, handleSeriesEdit, handleSeriesPause,
} from "./commands/series.ts";
import { isStaff, deliverPendingNotifications } from "./commands/shared.ts";

// ─── +event ───────────────────────────────────────────────────────────────────

addCmd({
  name: "+event",
  pattern: /^\+event(?:\/(\S+))?\s*(.*)/i,
  lock: "connected",
  category: "Events",
  help: `+event[/<switch>] [<args>]  — In-game event calendar with RSVP tracking.

Switches (all players):
  /list                            List events (default).
  /view <#>                        View event details and RSVP list.
  /rsvp <#>[=<status>]             RSVP: attending (default), maybe, decline.
  /unrsvp <#>                      Cancel your RSVP.
  /checkin <#>[=<player>]          Check in to an active event.
  /create <title>=<date>/<desc>    Create an event (pending approval if required).

Switches (staff and event organizer):
  /edit <#>/<field>=<value>        Edit: title, description, location, starttime,
                                     endtime, maxattendees, tags, reminders.
  /cancel <#>                      Mark event cancelled.
  /delete <#>                      Permanently delete an event.

Switches (staff only):
  /status <#>=<status>             Set: upcoming, active, completed, cancelled.
  /approve <#>                     Approve a pending player-created event.
  /reject <#>                      Reject and remove a pending event.
  /series                          List recurring event series.
  /series-create <title>=<cron>/<desc>   Create a recurring series.
  /series-edit <#>/<field>=<value>       Edit a series field.
  /series-pause <#>                      Toggle a series active/paused.

Examples:
  +event                           List upcoming events.
  +event/view 3                    View event #3.
  +event/rsvp 3                    RSVP attending to event #3.
  +event/rsvp 3=maybe              RSVP maybe to event #3.
  +event/unrsvp 3                  Cancel RSVP for event #3.
  +event/checkin 3                 Check yourself in (event must be active).
  +event/checkin 3=Alice           Staff/organizer: check in Alice.
  +event/create Summer Gala=2027-08-01 20:00/Annual summer gathering.
  +event/approve 5                 Approve pending event #5.
  +event/series-create Trivia=0 20 * * 5/Weekly Friday trivia night.`,

  exec: async (u: IUrsamuSDK) => {
    // Deliver any queued notifications (reminders, approvals, waitlist promotions)
    await deliverPendingNotifications(u);

    const sw  = (u.cmd.args[0] || "").toLowerCase().trim();
    const arg = (u.cmd.args[1] || "").trim();

    switch (sw) {
      case "":
      case "list":          return handleList(u);
      case "view":          return handleView(u, arg);
      case "rsvp":          return handleRsvp(u, arg);
      case "unrsvp":        return handleUnrsvp(u, arg);
      case "checkin":       return handleCheckin(u, arg);
      case "create":        return handleCreate(u, arg);
      case "edit":          return handleEdit(u, arg);
      case "status":        return handleStatus(u, arg);
      case "cancel":        return handleCancel(u, arg);
      case "delete":        return handleDelete(u, arg);
      case "approve":       return handleApprove(u, arg);
      case "reject":        return handleReject(u, arg);
      case "series":        return handleSeriesList(u);
      case "series-create": return handleSeriesCreate(u, arg);
      case "series-edit":   return handleSeriesEdit(u, arg);
      case "series-pause":  return handleSeriesPause(u, arg);
      default:              sendHelp(u);
    }
  },
});

// ─── +events alias ────────────────────────────────────────────────────────────

addCmd({
  name: "+events",
  pattern: /^\+events\s*(.*)/i,
  lock: "connected",
  category: "Events",
  help: `+events  — List all upcoming events. Alias for "+event/list".

Examples:
  +events    Show the event calendar.`,
  exec: async (u: IUrsamuSDK) => {
    await deliverPendingNotifications(u);
    return handleList(u);
  },
});

// ─── help ────────────────────────────────────────────────────────────────────

function sendHelp(u: IUrsamuSDK): void {
  const staff = isStaff(u);
  u.send(`%ch+event usage:%cn`);
  u.send(`  +event [/list]                             — list upcoming events`);
  u.send(`  +event/view <#>                            — event details + RSVPs`);
  u.send(`  +event/rsvp <#>[=attending|maybe|decline]  — RSVP`);
  u.send(`  +event/unrsvp <#>                          — cancel RSVP`);
  u.send(`  +event/checkin <#>[=<player>]              — check in (active events)`);
  u.send(`  +event/create <title>=<date>/<desc>        — create an event`);
  if (staff) {
    u.send(`  +event/edit <#>/<field>=<value>           — edit event field`);
    u.send(`  +event/status <#>=<status>                — set status`);
    u.send(`  +event/cancel <#>                         — cancel event`);
    u.send(`  +event/delete <#>                         — delete event`);
    u.send(`  +event/approve <#>                        — approve pending`);
    u.send(`  +event/reject <#>                         — reject pending`);
    u.send(`  +event/series                             — list series`);
    u.send(`  +event/series-create <t>=<cron>/<d>       — create series`);
    u.send(`  +event/series-edit <#>/<f>=<v>            — edit series`);
    u.send(`  +event/series-pause <#>                   — pause/resume series`);
  }
}
