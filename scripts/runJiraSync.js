import { syncJiraShifts } from "../src/services/jiraSync.js";
import {
  createJiraSyncScheduler,
  getJiraSyncIntervalMs,
} from "../src/services/jiraSyncScheduler.js";

const intervalMs = getJiraSyncIntervalMs();

if (intervalMs === null) {
  try {
    const { count } = await syncJiraShifts();
    console.log(
      `[jira-sync] Sync completed successfully: ${count} shift(s) synced`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[jira-sync] Sync failed: ${message}`);
    process.exitCode = 1;
  }
} else {
  const scheduler = createJiraSyncScheduler({ intervalMs });
  console.log(
    `[jira-sync] Scheduled sync enabled; running immediately and every ${
      intervalMs / 60_000
    } minute(s)`,
  );
  scheduler.start();
  await scheduler.runSync();

  const stopScheduler = () => {
    scheduler.stop();
    console.log("[jira-sync] Scheduled sync stopped");
  };
  process.once("SIGINT", stopScheduler);
  process.once("SIGTERM", stopScheduler);
}
