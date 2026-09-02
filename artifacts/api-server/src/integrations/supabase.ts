import { readEnv, type IntegrationStatus } from "./config";

export type SupabaseConfig = {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
  databaseUrl: string;
};

export function getSupabaseConfig(): Partial<SupabaseConfig> {
  const serviceRoleKey = readEnv("SUPABASE_J_SERVICE_ROLE_KEY") ?? readEnv("SUPABASE_SERVICE_ROLE_KEY");
  const url = readEnv("SUPABASE_J_URL") ?? readEnv("SUPABASE_URL");
  return {
    url,
    anonKey: readEnv("SUPABASE_ANON_KEY") ?? serviceRoleKey,
    serviceRoleKey,
    databaseUrl: readEnv("DATABASE_URL"),
  };
}

export function isSupabaseConfigured(): boolean {
  const cfg = getSupabaseConfig();
  return Boolean(cfg.url && cfg.anonKey && cfg.serviceRoleKey);
}

export async function checkSupabaseHealth(): Promise<IntegrationStatus> {
  const cfg = getSupabaseConfig();
  if (!isSupabaseConfigured()) {
    return {
      name: "supabase",
      configured: false,
      status: "not_configured",
      message: "SUPABASE_URL / keys not configured",
    };
  }
  const start = Date.now();
  try {
    const res = await fetch(`${cfg.url}/auth/v1/settings`, {
      headers: { apikey: cfg.anonKey as string },
    });
    return {
      name: "supabase",
      configured: true,
      status: res.ok ? "ok" : "error",
      latencyMs: Date.now() - start,
      message: res.ok ? "Auth API reachable" : `Auth API returned ${res.status}`,
    };
  } catch (err) {
    return {
      name: "supabase",
      configured: true,
      status: "error",
      latencyMs: Date.now() - start,
      message: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

export type SupabaseShiftSignal = {
  id: string;
  name: string;
  initials: string;
  role: string;
  team: string;
  region: string;
  status: string;
  ticket: string;
  environment: string;
  eta: string;
  updatedAt: string;
  isStale: boolean;
};

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

export async function listSupabaseShiftSignals(): Promise<SupabaseShiftSignal[] | null> {
  const cfg = getSupabaseConfig();
  if (!cfg.url || !cfg.serviceRoleKey) return null;
  const params = new URLSearchParams({
    select: "jira_issue_key,staff_member,team,region,environment,signal,action,Process_Status,jira_updated_at",
    order: "jira_updated_at.desc.nullslast,jira_issue_key.asc",
  });
  try {
    const response = await fetch(`${cfg.url.replace(/\/+$/, "")}/rest/v1/shifts?${params.toString()}`, {
      headers: {
        apikey: cfg.serviceRoleKey,
        Authorization: `Bearer ${cfg.serviceRoleKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) return null;
    return payload.flatMap((value): SupabaseShiftSignal[] => {
      if (!value || typeof value !== "object") return [];
      const row = value as Record<string, unknown>;
      const name = text(row.staff_member) || "Unassigned";
      const parts = name.trim().split(/\s+/).filter(Boolean);
      const initials = ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
      const signal = text(row.signal) || text(row.action) || text(row.Process_Status) || "Unknown";
      return [{
        id: text(row.jira_issue_key),
        name,
        initials,
        role: "Jira SHIFT",
        team: text(row.team) || "Unassigned",
        region: text(row.region) || "—",
        status: signal,
        ticket: text(row.jira_issue_key),
        environment: text(row.environment) || "—",
        eta: "—",
        updatedAt: text(row.jira_updated_at),
        isStale: signal.toLowerCase().includes("stale"),
      }];
    });
  } catch {
    return null;
  }
}

export const supabase = {
  config: getSupabaseConfig,
  isConfigured: isSupabaseConfigured,
  health: checkSupabaseHealth,
  listShiftSignals: listSupabaseShiftSignals,
};
