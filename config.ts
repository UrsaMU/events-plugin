import { eventsConfig } from "./db.ts";
import type { IEventsConfig } from "./types.ts";

const DEFAULTS: IEventsConfig = {
  id:               "config",
  requireApproval:  true,
  pollIntervalMs:   60_000,
  maxPlayerEvents:  10,
};

/**
 * Load the plugin config from DB, falling back to defaults if not yet set.
 */
export async function getConfig(): Promise<IEventsConfig> {
  return await eventsConfig.queryOne({ id: "config" }) ?? { ...DEFAULTS };
}

/**
 * Persist a partial config update and return the merged result.
 *
 * @param patch  Fields to update (id is not patchable)
 */
export async function updateConfig(
  patch: Partial<Omit<IEventsConfig, "id">>,
): Promise<IEventsConfig> {
  const current  = await getConfig();
  const updated: IEventsConfig = { ...current, ...patch };
  const existing = await eventsConfig.queryOne({ id: "config" });

  if (existing) {
    await eventsConfig.update({ id: "config" }, updated);
  } else {
    await eventsConfig.create(updated);
  }

  return updated;
}
