import { readEnv, type IntegrationStatus } from "./config";

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

export type JiraReleaseTask = {
  key: string;
  summary: string;
  dueDate: string;
  priority: string;
  environment: string;
  statusTicket: string;
  staffMember: string;
};

export function getJiraConfig(): Partial<JiraConfig> {
  return {
    baseUrl: readEnv("JIRA_BASE_URL"),
    email: readEnv("JIRA_EMAIL"),
    apiToken: readEnv("JIRA_API_TOKEN"),
    projectKey: readEnv("JIRA_PROJECT_KEY") ?? "SHIFT",
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
      message: "JIRA_BASE_URL / EMAIL / API_TOKEN not configured; using representative staff data",
    };
  }
  const start = Date.now();
  try {
    const res = await fetch(`${cfg.baseUrl}/rest/api/2/myself`, {
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
      message: err instanceof Error ? err.message : "Unknown error",
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

export async function listJiraTickets(): Promise<JiraTicket[]> {
  return FALLBACK_TICKETS;
}

function jiraValue(value: unknown): string {
  if (Array.isArray(value)) return jiraValue(value[0]);
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["value", "name", "displayName"]) {
      const candidate = record[key];
      if (typeof candidate === "string" || typeof candidate === "number") return String(candidate).trim();
    }
  }
  return "";
}

function findJiraFieldId(definitions: unknown, aliases: string[]): string | undefined {
  if (!Array.isArray(definitions)) return undefined;
  const field = definitions.find((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const record = candidate as Record<string, unknown>;
    return aliases.includes(jiraValue(record.name).toLowerCase()) && typeof record.id === "string";
  });
  return field && typeof field === "object" ? jiraValue((field as Record<string, unknown>).id) : undefined;
}

export async function listJiraReleaseTasks(): Promise<JiraReleaseTask[] | null> {
  const config = getJiraConfig();
  if (!isJiraConfigured() || !config.baseUrl || !config.email || !config.apiToken) return null;
  try {
    const fieldResponse = await fetch(`${config.baseUrl}/rest/api/3/field`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString("base64")}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!fieldResponse.ok) return null;
    const definitions = await fieldResponse.json() as unknown;
    const environmentFieldId = findJiraFieldId(definitions, ["environment"]);
    const statusTicketFieldId = findJiraFieldId(definitions, ["status_ticket", "status ticket"]);
    const staffMemberFieldId = findJiraFieldId(definitions, ["staff member"]);
    const requestedFields = [...new Set([
      "summary",
      "duedate",
      "priority",
      ...(environmentFieldId ? [environmentFieldId] : []),
      ...(statusTicketFieldId ? [statusTicketFieldId] : []),
      ...(staffMemberFieldId ? [staffMemberFieldId] : []),
    ])];
    const params = new URLSearchParams({
      jql: `project = "${config.projectKey ?? "SHIFT"}" ORDER BY updated DESC`,
      fields: requestedFields.join(","),
      maxResults: "100",
    });
    const response = await fetch(`${config.baseUrl}/rest/api/3/search/jql?${params.toString()}`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString("base64")}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const payload = await response.json() as { issues?: unknown };
    if (!Array.isArray(payload.issues)) return null;
    return payload.issues.flatMap((issue): JiraReleaseTask[] => {
      if (!issue || typeof issue !== "object") return [];
      const record = issue as Record<string, unknown>;
      const fields = record.fields && typeof record.fields === "object"
        ? record.fields as Record<string, unknown>
        : {};
      const key = jiraValue(record.key);
      if (!key) return [];
      return [{
        key,
        summary: jiraValue(fields.summary) || key,
        dueDate: jiraValue(fields.duedate),
        priority: jiraValue(fields.priority),
        environment: environmentFieldId ? jiraValue(fields[environmentFieldId]) : "",
        statusTicket: statusTicketFieldId ? jiraValue(fields[statusTicketFieldId]) : "",
        staffMember: staffMemberFieldId ? jiraValue(fields[staffMemberFieldId]) : "",
      }];
    });
  } catch {
    return null;
  }
}

function normalizeEnvironment(value: string): JiraTicket["environment"] {
  const normalized = value.trim().toUpperCase();
  if (normalized === "PRO" || normalized.includes("PROD")) return "PROD";
  if (normalized.includes("UAT")) return "UAT";
  if (normalized.includes("SIT")) return "SIT";
  return "STAGING";
}

function parseDateOnly(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(timestamp) ? null : timestamp;
}

export async function listJiraUpcomingTasks(): Promise<JiraTicket[] | null> {
  const tasks = await listJiraReleaseTasks();
  if (!tasks) return null;
  const today = new Date();
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const end = start + (30 * 24 * 60 * 60 * 1000);
  return tasks
    .filter((task) => {
      if (task.statusTicket.trim().toLowerCase() === "completed") return false;
      const due = parseDateOnly(task.dueDate);
      return due !== null && due >= start && due <= end;
    })
    .sort((a, b) => (parseDateOnly(a.dueDate) ?? 0) - (parseDateOnly(b.dueDate) ?? 0))
    .map((task) => ({
      id: task.key,
      key: task.key,
      summary: task.summary,
      status: task.statusTicket || "—",
      assignee: task.staffMember || "—",
      environment: normalizeEnvironment(task.environment),
      updatedAt: task.dueDate,
    }));
}

export const jira = {
  config: getJiraConfig,
  isConfigured: isJiraConfigured,
  health: checkJiraHealth,
  listTickets: listJiraTickets,
  listReleaseTasks: listJiraReleaseTasks,
  listUpcomingTasks: listJiraUpcomingTasks,
};
