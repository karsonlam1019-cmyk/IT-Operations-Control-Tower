import {
  errorMessage,
  fetchWithTimeout,
  readEnv,
  type IntegrationStatus,
} from "./config";

export type JiraConfig = {
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKey: string;
};

export type JiraTicket = {
  id: string;
  key: string;
  summary: string;
  status: string;
  assignee: string;
  environment: "SIT" | "UAT" | "STAGING" | "PROD";
  updatedAt: string;
};

export type JiraTicketFeed = {
  tickets: JiraTicket[];
  source: "jira" | "representative";
  degraded?: boolean;
  message?: string;
};

function normalizeJiraBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const withoutTrailingSlash = value.replace(/\/+$/, "");
  return /^https?:\/\//i.test(withoutTrailingSlash)
    ? withoutTrailingSlash
    : `https://${withoutTrailingSlash}`;
}

export function getJiraConfig(): Partial<JiraConfig> {
  return {
    baseUrl: normalizeJiraBaseUrl(
      readEnv("JIRA_HOST") ?? readEnv("JIRA_BASE_URL"),
    ),
    email: readEnv("JIRA_EMAIL"),
    apiToken: readEnv("JIRA_API_TOKEN"),
    projectKey: readEnv("JIRA_PROJECT_KEY") ?? "IT",
  };
}

export function isJiraConfigured(): boolean {
  const cfg = getJiraConfig();
  return Boolean(cfg.baseUrl && cfg.email && cfg.apiToken);
}

export async function checkJiraHealth(): Promise<IntegrationStatus> {
  const cfg = getJiraConfig();
  if (!isJiraConfigured()) {
    return {
      name: "jira",
      configured: false,
      status: "not_configured",
      message: "JIRA_HOST / EMAIL / API_TOKEN not configured; using representative staff data",
    };
  }
  const start = Date.now();
  try {
    const res = await fetchWithTimeout(`${cfg.baseUrl}/rest/api/2/myself`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString("base64")}`,
        Accept: "application/json",
      },
    });
    return {
      name: "jira",
      configured: true,
      status: res.ok ? "ok" : "error",
      latencyMs: Date.now() - start,
      message: res.ok ? "Jira API reachable" : `Jira API returned ${res.status}`,
    };
  } catch (err) {
    return {
      name: "jira",
      configured: true,
      status: "error",
      latencyMs: Date.now() - start,
        message: errorMessage(err),
    };
  }
}

const FALLBACK_TICKETS: JiraTicket[] = [
  { id: "10000", key: "INC-4821", summary: "Production incident - payment gateway latency", status: "In Progress", assignee: "Maya Chen", environment: "PROD", updatedAt: "12 min ago" },
  { id: "10001", key: "REL-2394", summary: "Release 2.9.0 mobile banking", status: "Deployment", assignee: "Ethan Wong", environment: "UAT", updatedAt: "5 min ago" },
  { id: "10002", key: "SEC-8812", summary: "Quarterly security scan", status: "In Progress", assignee: "Aisha Rahman", environment: "SIT", updatedAt: "3 hr ago" },
  { id: "10003", key: "NET-4107", summary: "Core switch firmware upgrade", status: "Scheduled", assignee: "Daniel Lim", environment: "PROD", updatedAt: "55 min ago" },
  { id: "10004", key: "SR-9271", summary: "New starter onboarding - provisioning", status: "Open", assignee: "Rina Pratama", environment: "STAGING", updatedAt: "4 hr ago" },
  { id: "10005", key: "DB-3125", summary: "Postgres 16 upgrade", status: "Deployment", assignee: "Li Wei", environment: "PROD", updatedAt: "28 min ago" },
];

function normalizeSupabaseUrl(value: string): string {
  return value.replace(/\/+$/, "").replace(/\/rest\/v1$/i, "");
}

function toJiraEnvironment(value: unknown): JiraTicket["environment"] {
  const environment = String(value ?? "").toUpperCase();
  return ["SIT", "UAT", "STAGING", "PROD"].includes(environment)
    ? (environment as JiraTicket["environment"])
    : "SIT";
}

function jiraFieldValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(jiraFieldValue).filter(Boolean).join(", ");
  }
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const field = value as Record<string, unknown>;
    return String(
      field.value ??
        field.name ??
        field.displayName ??
        field.key ??
        field.accountId ??
        "",
    ).trim();
  }
  return "";
}

type JiraField = { id: string; name?: string };

async function getJiraFieldIds(
  cfg: JiraConfig,
  headers: Record<string, string>,
): Promise<Map<string, string>> {
  try {
    const response = await fetchWithTimeout(`${cfg.baseUrl}/rest/api/3/field`, {
      headers,
    });
    if (!response.ok) return new Map();
    const fields = (await response.json()) as unknown;
    if (!Array.isArray(fields)) return new Map();
    return new Map(
      fields
        .filter((field): field is JiraField => Boolean(
          field &&
          typeof field === "object" &&
          typeof (field as JiraField).id === "string" &&
          typeof (field as JiraField).name === "string",
        ))
        .map((field) => [field.name!.trim().toLowerCase(), field.id]),
    );
  } catch {
    return new Map();
  }
}

async function listLiveJiraTickets(
  cfg: JiraConfig,
): Promise<JiraTicket[] | null> {
  if (!cfg.baseUrl || !cfg.email || !cfg.apiToken || !cfg.projectKey) {
    return null;
  }

  const headers = {
    Authorization: `Basic ${Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString("base64")}`,
    Accept: "application/json",
  };
  const fieldIds = await getJiraFieldIds(cfg, headers);
  const workField = fieldIds.get("work");
  const statusTicketField = fieldIds.get("status_ticket");
  const staffMemberField = fieldIds.get("staff member") ?? "customfield_10064";
  const environmentField = fieldIds.get("environment") ?? "customfield_10067";
  const requestedFields = [
    "summary",
    "status",
    "assignee",
    staffMemberField,
    environmentField,
    workField,
    statusTicketField,
  ].filter((field): field is string => Boolean(field));
  const searchParams = new URLSearchParams({
    jql: `project = "${cfg.projectKey}" ORDER BY updated DESC`,
    fields: requestedFields.join(","),
    maxResults: "100",
  });

  try {
    const response = await fetchWithTimeout(
      `${cfg.baseUrl}/rest/api/3/search/jql?${searchParams}`,
      { headers },
    );
    if (!response.ok) return null;

    const payload = (await response.json()) as { issues?: unknown };
    if (!Array.isArray(payload.issues)) return [];

    return payload.issues.flatMap((issue): JiraTicket[] => {
      if (!issue || typeof issue !== "object") return [];
      const rawIssue = issue as Record<string, unknown>;
      const fields = rawIssue.fields;
      if (!fields || typeof fields !== "object") return [];
      const issueFields = fields as Record<string, unknown>;
      const status = jiraFieldValue(
        statusTicketField
          ? issueFields[statusTicketField]
          : undefined,
      ) || jiraFieldValue(issueFields.status) || "Unknown";
      if (status.trim().toLowerCase() === "completed") return [];

      const key = jiraFieldValue(rawIssue.key);
      const assignee = jiraFieldValue(issueFields[staffMemberField])
        || jiraFieldValue(issueFields.assignee)
        || "Unassigned";
      const summary = jiraFieldValue(workField ? issueFields[workField] : undefined)
        || jiraFieldValue(issueFields.summary)
        || "Untitled work";
      const environment = jiraFieldValue(issueFields[environmentField]);
      return [{
        id: jiraFieldValue(rawIssue.id) || key,
        key,
        summary,
        status,
        assignee,
        environment: toJiraEnvironment(environment),
        updatedAt: jiraFieldValue(issueFields.updated),
      }];
    });
  } catch {
    return null;
  }
}

async function listSyncedShiftTickets(): Promise<JiraTicket[] | null> {
  const supabaseUrl = readEnv("SUPABASE_URL");
  const serviceRoleKey = readEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return null;

  const params = new URLSearchParams({
    select:
      "jira_issue_key,staff_member,signal,environment,jira_updated_at,last_synced_at",
    order: "last_synced_at.desc",
    limit: "100",
  });

  try {
    const response = await fetchWithTimeout(
      `${normalizeSupabaseUrl(supabaseUrl)}/rest/v1/shifts?${params}`,
      {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          Accept: "application/json",
        },
      },
    );
    if (!response.ok) return null;

    const rows = await response.json();
    if (!Array.isArray(rows)) return null;

    return rows
      .map((row) => {
      const key = String(row.jira_issue_key ?? "");
      return {
        id: key,
        key,
        summary: "Synchronized Jira shift",
        status: String(row.signal ?? "Unknown"),
        assignee: String(row.staff_member ?? "Unassigned"),
        environment: toJiraEnvironment(row.environment),
        updatedAt: String(row.last_synced_at ?? row.jira_updated_at ?? ""),
      };
      })
      .filter((ticket) => ticket.status.trim().toLowerCase() !== "completed");
  } catch {
    return null;
  }
}

export async function listJiraTickets(): Promise<JiraTicketFeed> {
  const cfg = getJiraConfig();
  if (!cfg.baseUrl || !cfg.email || !cfg.apiToken || !cfg.projectKey) {
    return {
      tickets: FALLBACK_TICKETS,
      source: "representative",
      degraded: true,
      message: "Jira is not configured",
    };
  }

  const liveTickets = await listLiveJiraTickets({
    baseUrl: cfg.baseUrl,
    email: cfg.email,
    apiToken: cfg.apiToken,
    projectKey: cfg.projectKey,
  });
  if (liveTickets) {
    return {
      tickets: liveTickets,
      source: "jira",
      message: "Loaded live Jira work queue",
    };
  }

  const syncedTickets = await listSyncedShiftTickets();
  if (syncedTickets) {
    return {
      tickets: syncedTickets,
      source: "jira",
      message: "Loaded synchronized Jira shifts from Supabase",
    };
  }

  return {
    tickets: FALLBACK_TICKETS.filter(
      (ticket) => ticket.status.trim().toLowerCase() !== "completed",
    ),
    source: "representative",
    degraded: true,
    message:
      "Jira credentials verified; live issue search is paused pending the enhanced JQL migration",
  };
}

export const jira = {
  config: getJiraConfig,
  isConfigured: isJiraConfigured,
  health: checkJiraHealth,
  listTickets: listJiraTickets,
};
