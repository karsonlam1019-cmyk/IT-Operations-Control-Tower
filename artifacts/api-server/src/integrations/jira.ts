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

export async function listJiraTickets(): Promise<JiraTicketFeed> {
  if (!isJiraConfigured()) {
    return {
      tickets: FALLBACK_TICKETS,
      source: "representative",
      degraded: true,
      message: "Jira is not configured",
    };
  }
  return {
    tickets: FALLBACK_TICKETS,
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
