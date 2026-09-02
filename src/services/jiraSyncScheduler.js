import { syncJiraShifts } from "./jiraSync.js";

const MAX_INTERVAL_MS = 2_147_483_647;

export function getJiraSyncIntervalMs(environment = process.env) {
  const rawInterval = environment.JIRA_SYNC_INTERVAL_MINUTES;

  if (rawInterval === undefined || rawInterval.trim() === "") {
    return null;
  }

  const minutes = Number(rawInterval);
  const intervalMs = minutes * 60 * 1000;

  if (
    !Number.isFinite(minutes) ||
    minutes <= 0 ||
    !Number.isSafeInteger(minutes * 60 * 1000) ||
    intervalMs > MAX_INTERVAL_MS
  ) {
    throw new Error(
      "JIRA_SYNC_INTERVAL_MINUTES must be a positive number no greater than 35791",
    );
  }

  return intervalMs;
}

export function createJiraSyncScheduler({
  intervalMs,
  sync = syncJiraShifts,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  log = console,
} = {}) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("A positive Jira sync interval is required");
  }

  let timer;
  let syncInProgress = false;

  async function runSync() {
    if (syncInProgress) {
      log.warn(
        "[jira-sync] Skipping scheduled run because a sync is still in progress",
      );
      return { skipped: true };
    }

    syncInProgress = true;
    try {
      const result = await sync();
      log.log(
        `[jira-sync] Sync completed successfully: ${result.count} shift(s) synced`,
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`[jira-sync] Scheduled sync failed: ${message}`);
      return { error };
    } finally {
      syncInProgress = false;
    }
  }

  function start() {
    if (timer !== undefined) {
      return;
    }

    timer = setIntervalImpl(() => {
      return runSync();
    }, intervalMs);
  }

  function stop() {
    if (timer === undefined) {
      return;
    }

    clearIntervalImpl(timer);
    timer = undefined;
  }

  return {
    runSync,
    start,
    stop,
  };
}
