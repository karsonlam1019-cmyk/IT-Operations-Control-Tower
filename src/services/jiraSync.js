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

  const supabase = createSupabaseClient(supabaseUrl, supabaseServiceRoleKey, {
    realtime: { transport: WebSocket },
  });

  const normalizedJiraHost = jiraHost
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");

  const authorization = `Basic ${Buffer.from(
    `${jiraEmail}:${jiraApiToken}`,
  ).toString("base64")}`;

  console.log("[jira-sync] Fetching Jira issues from project SHIFT...");

  // Request the fields we need (standard + custom fields)
  // Note: Custom fields usually have IDs like customfield_10001.
  // For now we request common fields. We will refine the field IDs later if needed.
  const searchParams = new URLSearchParams({
    jql: 'project = "SHIFT" ORDER BY updated DESC',
    fields: "summary,assignee,status,updated,duedate",
    maxResults: "100",
  });

  const jiraUrl = `https://${normalizedJiraHost}/rest/api/3/search?${searchParams}`;

  let response = await fetchImpl(jiraUrl, {
    headers: {
      Authorization: authorization,
      Accept: "application/json",
    },
  });

  // Fallback for newer Jira search endpoint
  if (!response.ok && [404, 410].includes(response.status)) {
    const enhancedUrl = `https://${normalizedJiraHost}/rest/api/3/search/jql?${searchParams}`;
    response = await fetchImpl(enhancedUrl, {
      headers: {
        Authorization: authorization,
        Accept: "application/json",
      },
    });
  }

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(
      `Jira API request failed with ${response.status} ${response.statusText}: ${responseBody}`,
    );
  }

  const payload = await response.json();
  const issues = Array.isArray(payload.issues) ? payload.issues : [];

  console.log(`[jira-sync] Received ${issues.length} Jira issue(s)`);

  // Transform Jira issues → our shifts table format
  const rows = issues.map((issue) => {
    const fields = issue.fields || {};

    return {
      jira_issue_key: issue.key,                          // e.g. SHIFT-123
      staff_member: fields.assignee?.displayName || fields.assignee?.emailAddress || "Unassigned",
      team: null,                                         // will map custom field later
      region: null,                                       // will map custom field later
      environment: null,                                  // will map custom field later
      signal: fields.status?.name || "Unknown",           // Status → Signal
      action: null,                                       // will map custom field later
      due_date: fields.duedate || null,
      jira_updated_at: fields.updated ? new Date(fields.updated).toISOString() : null,
      last_synced_at: new Date().toISOString(),
    };
  });

  if (rows.length === 0) {
    console.log("[jira-sync] No shifts to upsert");
    return { count: 0 };
  }

  // Upsert into Supabase
  const { error } = await supabase
    .from("shifts")
    .upsert(rows, { onConflict: "jira_issue_key" });

  if (error) {
    throw new Error(`Supabase shifts upsert failed: ${error.message}`);
  }

  console.log(`[jira-sync] Successfully upserted ${rows.length} shift(s)`);
  return { count: rows.length };
}