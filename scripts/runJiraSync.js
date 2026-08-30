import { syncJiraShifts } from "../src/services/jiraSync.js";

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
