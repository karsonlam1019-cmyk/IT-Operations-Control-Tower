import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

const REQUIRED_ENVIRONMENT_VARIABLES = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "JIRA_HOST",
  "JIRA_EMAIL",
  "JIRA_API_TOKEN",
];

function getRequiredEnvironment() {
  const missing = REQUIRED_ENVIRONMENT_VARIABLES.filter(
    (name) => !process.env[name],
  );

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }

  return {
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    jiraHost: process.env.JIRA_HOST,
    jiraEmail: process.env.JIRA_EMAIL,
    jiraApiToken: process.env.JIRA_API_TOKEN,
  };
}

export async function syncJiraShifts({
  fetchImpl = fetch,
  createSupabaseClient = createClient,
} = {}) {
  const {
    supabaseUrl,
    supabaseServiceRoleKey,
    jiraHost,
    jiraEmail,
    jiraApiToken,
  } = getRequiredEnvironment();

  const normalizedSupabaseUrl = new URL(supabaseUrl).origin;
  const supabase = createSupabaseClient(
    normalizedSupabaseUrl,
    supabaseServiceRoleKey,
    {
      realtime: { transport: WebSocket },
    },
  );
  const normalizedJiraHost = jiraHost
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  const authorization = `Basic ${Buffer.from(
    `${jiraEmail}:${jiraApiToken}`,
  ).toString("base64")}`;

  console.log(
    "[jira-sync] Fetching Jira issues updated in the last 10 minutes",
  );
  const issues = [];
  let nextPageToken;

  do {
    const params = new URLSearchParams({
      jql: "updated >= -10m",
      maxResults: "100",
    });
    for (const field of ["assignee", "status", "updated"]) {
      params.append("fields", field);
    }
    if (nextPageToken) {
      params.set("nextPageToken", nextPageToken);
    }

    const jiraUrl = `https://${normalizedJiraHost}/rest/api/3/search/jql?${params}`;
    const response = await fetchImpl(jiraUrl, {
      headers: {
        Authorization: authorization,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const responseBody = await response.text();
      throw new Error(
        `Jira API request failed with ${response.status} ${response.statusText}: ${responseBody}`,
      );
    }

    const payload = await response.json();
    if (Array.isArray(payload.issues)) {
      issues.push(...payload.issues);
    }

    nextPageToken = payload.nextPageToken;
    if (payload.isLast === true) {
      nextPageToken = undefined;
    }
  } while (nextPageToken);

  const rows = issues.map((issue) => ({
    jira_issue_id: issue.id,
    staff_id: issue.fields?.assignee?.accountId || "unassigned",
    shift_status: issue.fields?.status?.name || "unknown",
    updated_at: issue.fields?.updated,
  }));

  console.log(`[jira-sync] Received ${rows.length} Jira issue(s)`);

  if (rows.length === 0) {
    console.log("[jira-sync] No shifts to upsert");
    return { syncedCount: 0 };
  }

  const { error } = await supabase
    .from("shifts")
    .upsert(rows, { onConflict: "jira_issue_id" });

  if (error) {
    throw new Error(`Supabase shifts upsert failed: ${error.message}`);
  }

  console.log(`[jira-sync] Upserted ${rows.length} shift(s)`);
  return { syncedCount: rows.length };
}
