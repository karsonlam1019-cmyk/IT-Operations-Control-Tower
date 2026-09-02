import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  compareShifts,
  normalizeRecords,
  readJiraValue,
  SHIFT_FIELDS,
  sourceValueText,
  type ReconciliationReport,
  type ShiftField,
  type ShiftMapping,
} from "./shift-sync";

const PROJECT_KEY = "SHIFT";
const PAGE_SIZE = 100;
const SUPABASE_PAGE_SIZE = 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const SUPABASE_SYNC_COLUMNS = ["last_synced_at"];

export type Provider = "jira" | "supabase";
export type FailureCategory = "authentication" | "connectivity" | "schema" | "malformed";

export class VerificationFailure extends Error {
  constructor(
    readonly provider: Provider,
    readonly category: FailureCategory,
    message: string,
  ) {
    super(message);
    this.name = "VerificationFailure";
  }
}

export type JiraConfig = {
  baseUrl: string;
  email: string;
  apiToken: string;
};

export type SupabaseConfig = {
  url: string;
  serviceRoleKey: string;
};

type JiraFieldDefinition = {
  id: string;
  name: string;
  custom: boolean;
};

type OpenApiDocument = {
  definitions?: Record<string, { properties?: Record<string, unknown> }>;
  components?: {
    schemas?: Record<string, { properties?: Record<string, unknown> }>;
  };
};

export type LiveShiftSources = {
  jira: JiraConfig;
  supabase: SupabaseConfig;
  mapping: ShiftMapping;
  jiraIssues: unknown[];
  supabaseRows: unknown[];
};

export type LiveVerificationResult =
  | {
      ok: true;
      report: ReconciliationReport;
      mapping: ShiftMapping;
    }
  | {
      ok: false;
      failure: {
        provider: Provider;
        category: FailureCategory;
        message: string;
      };
    };

export type LiveSyncResult =
  | {
      ok: true;
      syncedCount: number;
      report: ReconciliationReport;
      mapping: ShiftMapping;
    }
  | {
      ok: false;
      failure: {
        provider: Provider;
        category: FailureCategory;
        message: string;
      };
    };

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && !value.toUpperCase().includes("PASTE") && !value.toUpperCase().includes("YOUR_")
    ? value
    : undefined;
}

function getJiraConfig(): JiraConfig {
  const baseUrl = readEnv("JIRA_BASE_URL");
  const email = readEnv("JIRA_EMAIL");
  const apiToken = readEnv("JIRA_API_TOKEN");
  if (!baseUrl || !email || !apiToken) {
    throw new VerificationFailure(
      "jira",
      "authentication",
      "Jira credentials are not configured; set JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN.",
    );
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), email, apiToken };
}

function getSupabaseConfig(): SupabaseConfig {
  const url = readEnv("SUPABASE_J_URL") ?? readEnv("SUPABASE_URL");
  const serviceRoleKey = readEnv("SUPABASE_J_SERVICE_ROLE_KEY") ?? readEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRoleKey) {
    throw new VerificationFailure(
      "supabase",
      "authentication",
      "Supabase credentials are not configured; set SUPABASE_J_URL and SUPABASE_J_SERVICE_ROLE_KEY.",
    );
  }
  return { url: url.replace(/\/+$/, ""), serviceRoleKey };
}

function classifyHttpFailure(
  provider: Provider,
  label: string,
  status: number,
): VerificationFailure {
  if (status === 401 || status === 403) {
    return new VerificationFailure(provider, "authentication", `${label} rejected the configured credentials (HTTP ${status}).`);
  }
  if (status === 404 && provider === "supabase" && label.includes("public.shifts")) {
    return new VerificationFailure(provider, "schema", "Supabase could not find public.shifts.");
  }
  if (status >= 400 && status < 500) {
    return new VerificationFailure(provider, "schema", `${label} rejected the requested schema or mapping (HTTP ${status}).`);
  }
  return new VerificationFailure(provider, "connectivity", `${label} is unavailable (HTTP ${status}).`);
}

async function fetchResponse(
  provider: Provider,
  label: string,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw classifyHttpFailure(provider, label, response.status);
    return response;
  } catch (error) {
    if (error instanceof VerificationFailure) throw error;
    throw new VerificationFailure(provider, "connectivity", `${label} could not be reached.`);
  }
}

async function fetchJson<T>(
  provider: Provider,
  label: string,
  url: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetchResponse(provider, label, url, init);
  try {
    return (await response.json()) as T;
  } catch {
    throw new VerificationFailure(provider, "malformed", `${label} returned invalid JSON.`);
  }
}

function jiraHeaders(config: JiraConfig): Record<string, string> {
  return {
    Authorization: `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString("base64")}`,
    Accept: "application/json",
  };
}

function supabaseHeaders(config: SupabaseConfig): Record<string, string> {
  return {
    apikey: config.serviceRoleKey,
    Authorization: `Bearer ${config.serviceRoleKey}`,
    Accept: "application/json",
  };
}

async function authorizeJira(config: JiraConfig): Promise<void> {
  await fetchJson<Record<string, unknown>>(
    "jira",
    "Jira authorization check",
    `${config.baseUrl}/rest/api/3/myself`,
    { headers: jiraHeaders(config) },
  );
}

function schemaProperties(document: OpenApiDocument, table: string): string[] {
  const candidates = [
    ...Object.entries(document.definitions ?? {}),
    ...Object.entries(document.components?.schemas ?? {}),
  ];
  const schema = candidates.find(([name]) => {
    const normalized = name.toLowerCase();
    return normalized === table || normalized === `public.${table}` || normalized.endsWith(`.${table}`);
  })?.[1];
  return schema?.properties ? Object.keys(schema.properties) : [];
}

async function discoverSupabaseColumns(config: SupabaseConfig): Promise<string[]> {
  const document = await fetchJson<OpenApiDocument>(
    "supabase",
    "Supabase schema discovery",
    `${config.url}/rest/v1/`,
    {
      headers: {
        ...supabaseHeaders(config),
        Accept: "application/openapi+json",
      },
    },
  );
  const columns = schemaProperties(document, "shifts");
  if (!columns.length) {
    throw new VerificationFailure(
      "supabase",
      "schema",
      "public.shifts is not exposed in the live Supabase schema, or it has no discoverable columns.",
    );
  }
  return columns;
}

const COLUMN_ALIASES: Record<ShiftField, string[]> = {
  staffMember: ["staff_member"],
  team: ["team"],
  region: ["region"],
  environment: ["environment"],
  signal: ["signal"],
  action: ["action"],
  processStatus: ["process_status"],
  priority: ["priority"],
  dueDate: ["due_date", "due date", "duedate"],
};

const IDENTIFIER_ALIASES = ["jira_issue_key"];
const JIRA_FIELD_ALIASES: Record<ShiftField, string[]> = {
  staffMember: ["staff member"],
  team: ["team01"],
  region: ["region"],
  environment: ["environment"],
  signal: ["signal"],
  action: ["status"],
  processStatus: ["status_ticket"],
  priority: ["priority"],
  dueDate: ["due date", "duedate"],
};

function resolveColumn(columns: string[], semantic: string, aliases: string[]): string {
  const matches = columns.filter((column) => aliases.includes(column.toLowerCase()));
  if (matches.length === 0) {
    throw new VerificationFailure(
      "supabase",
      "schema",
      `public.shifts is missing a required ${semantic} column; expected one of ${aliases.join(", ")}.`,
    );
  }
  if (matches.length > 1) {
    throw new VerificationFailure(
      "supabase",
      "schema",
      `public.shifts has ambiguous ${semantic} columns; found ${matches.join(", ")}.`,
    );
  }
  return matches[0];
}

function resolveMapping(columns: string[]): ShiftMapping {
  const identifier = resolveColumn(columns, "Jira identifier", IDENTIFIER_ALIASES);
  const fields = {} as ShiftMapping["fields"];
  for (const field of SHIFT_FIELDS) {
    fields[field] = {
      supabaseColumn: field === "processStatus"
        ? resolveColumn(columns, "process status", ["process_status", "Process_Status"])
        : resolveColumn(columns, field, COLUMN_ALIASES[field]),
      jiraField: "",
    };
  }
  const updatedAt = resolveColumn(columns, "Jira update timestamp", ["jira_updated_at"]);
  for (const requiredColumn of SUPABASE_SYNC_COLUMNS) {
    resolveColumn(columns, requiredColumn, [requiredColumn]);
  }
  return {
    identifier: { supabaseColumn: identifier, jiraField: "key" },
    fields,
    updatedAt: { supabaseColumn: updatedAt, jiraField: "updated" },
  };
}

async function discoverJiraFields(config: JiraConfig): Promise<JiraFieldDefinition[]> {
  const fields = await fetchJson<unknown>(
    "jira",
    "Jira field discovery",
    `${config.baseUrl}/rest/api/3/field`,
    { headers: jiraHeaders(config) },
  );
  if (!Array.isArray(fields)) {
    throw new VerificationFailure("jira", "malformed", "Jira field discovery returned an unexpected payload.");
  }
  const definitions = fields.flatMap((field): JiraFieldDefinition[] => {
    if (!field || typeof field !== "object") return [];
    const record = field as Record<string, unknown>;
    return typeof record.id === "string" && typeof record.name === "string"
      ? [{ id: record.id, name: record.name, custom: record.custom === true }]
      : [];
  });
  if (!definitions.length) {
    throw new VerificationFailure("jira", "malformed", "Jira field discovery returned no usable fields.");
  }
  return definitions;
}

function resolveJiraField(fields: JiraFieldDefinition[], semantic: ShiftField): string {
  const aliases = JIRA_FIELD_ALIASES[semantic];
  const matches = fields.filter((field) => aliases.includes(field.name.trim().toLowerCase()));
  const customMatches = matches.filter((field) => field.custom);
  const candidates = customMatches.length ? customMatches : matches;
  if (candidates.length === 0) {
    throw new VerificationFailure(
      "jira",
      "schema",
      `Jira SHIFT is missing a uniquely named ${semantic} field; expected one of ${aliases.join(", ")}.`,
    );
  }
  if (candidates.length > 1) {
    throw new VerificationFailure("jira", "schema", `Jira SHIFT has ambiguous ${semantic} fields.`);
  }
  return candidates[0].id;
}

async function listJiraIssues(config: JiraConfig, mapping: ShiftMapping): Promise<unknown[]> {
  const fields = [
    "id",
    "key",
    "status",
    "updated",
    ...SHIFT_FIELDS.map((field) => mapping.fields[field].jiraField),
  ];
  const issues: unknown[] = [];
  let nextPageToken: string | undefined;
  while (true) {
    const params = new URLSearchParams({
      jql: `project = ${PROJECT_KEY} ORDER BY updated ASC`,
      maxResults: String(PAGE_SIZE),
      fields: [...new Set(fields)].join(","),
    });
    if (nextPageToken) params.set("nextPageToken", nextPageToken);
    const page = await fetchJson<unknown>(
      "jira",
      "Jira SHIFT issue search",
      `${config.baseUrl}/rest/api/3/search/jql?${params.toString()}`,
      { headers: jiraHeaders(config) },
    );
    if (!page || typeof page !== "object") {
      throw new VerificationFailure("jira", "malformed", "Jira SHIFT search returned an unexpected payload.");
    }
    const payload = page as { issues?: unknown; isLast?: unknown; nextPageToken?: unknown };
    if (!Array.isArray(payload.issues) || typeof payload.isLast !== "boolean") {
      throw new VerificationFailure("jira", "malformed", "Jira SHIFT search omitted cursor pagination data.");
    }
    issues.push(...payload.issues);
    if (payload.isLast) break;
    if (typeof payload.nextPageToken !== "string" || !payload.nextPageToken) {
      throw new VerificationFailure("jira", "malformed", "Jira SHIFT search did not return a next-page cursor.");
    }
    if (payload.nextPageToken === nextPageToken) {
      throw new VerificationFailure("jira", "malformed", "Jira SHIFT pagination did not advance.");
    }
    nextPageToken = payload.nextPageToken;
    if (issues.length > 100_000) {
      throw new VerificationFailure("jira", "malformed", "Jira SHIFT pagination exceeded the safety limit.");
    }
  }
  return issues;
}

export async function listSupabaseRows(
  config: SupabaseConfig,
  mapping: ShiftMapping,
): Promise<unknown[]> {
  const rows: unknown[] = [];
  let offset = 0;
  while (true) {
    const params = new URLSearchParams({
      select: "*",
      order: mapping.identifier.supabaseColumn,
      limit: String(SUPABASE_PAGE_SIZE),
      offset: String(offset),
    });
    const page = await fetchJson<unknown>(
      "supabase",
      "Supabase public.shifts",
      `${config.url}/rest/v1/shifts?${params.toString()}`,
      { headers: supabaseHeaders(config) },
    );
    if (!Array.isArray(page)) {
      throw new VerificationFailure("supabase", "malformed", "Supabase public.shifts returned an unexpected payload.");
    }
    rows.push(...page);
    if (page.length < SUPABASE_PAGE_SIZE) break;
    offset += page.length;
    if (offset > 1_000_000) {
      throw new VerificationFailure("supabase", "malformed", "Supabase public.shifts pagination exceeded the safety limit.");
    }
  }
  return rows;
}

export async function loadLiveShiftSources(): Promise<LiveShiftSources> {
  const jira = getJiraConfig();
  await authorizeJira(jira);
  const supabase = getSupabaseConfig();
  const columns = await discoverSupabaseColumns(supabase);
  const mapping = resolveMapping(columns);
  const jiraFields = await discoverJiraFields(jira);
  for (const field of SHIFT_FIELDS) {
    mapping.fields[field].jiraField = field === "action"
      ? "status"
      : resolveJiraField(jiraFields, field);
  }
  const [jiraIssues, supabaseRows] = await Promise.all([
    listJiraIssues(jira, mapping),
    listSupabaseRows(supabase, mapping),
  ]);
  return { jira, supabase, mapping, jiraIssues, supabaseRows };
}

function buildSupabaseRow(issue: unknown, sources: LiveShiftSources): Record<string, string> {
  const { mapping } = sources;
  const row: Record<string, string> = {
    [mapping.identifier.supabaseColumn]: sourceValueText(readJiraValue(issue, mapping.identifier.jiraField)),
  };
  for (const field of SHIFT_FIELDS) {
    row[mapping.fields[field].supabaseColumn] = sourceValueText(
      readJiraValue(issue, mapping.fields[field].jiraField),
    );
  }
  const updatedAt = sourceValueText(readJiraValue(issue, mapping.updatedAt.jiraField));
  const normalizedUpdatedAt = new Date(updatedAt);
  if (Number.isNaN(normalizedUpdatedAt.getTime())) {
    throw new VerificationFailure("jira", "malformed", "Jira SHIFT contains an invalid updated timestamp.");
  }
  row[mapping.updatedAt.supabaseColumn] = normalizedUpdatedAt.toISOString();
  row.last_synced_at = new Date().toISOString();
  return row;
}

async function upsertSupabaseRows(
  config: SupabaseConfig,
  mapping: ShiftMapping,
  rows: Record<string, string>[],
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += PAGE_SIZE) {
    const batch = rows.slice(offset, offset + PAGE_SIZE);
    const params = new URLSearchParams({ on_conflict: mapping.identifier.supabaseColumn });
    await fetchResponse(
      "supabase",
      "Supabase public.shifts write",
      `${config.url}/rest/v1/shifts?${params.toString()}`,
      {
        method: "POST",
        headers: {
          ...supabaseHeaders(config),
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(batch),
      },
    );
  }
}

export async function verifyLiveShiftSync(): Promise<LiveVerificationResult> {
  try {
    const sources = await loadLiveShiftSources();
    return {
      ok: true,
      mapping: sources.mapping,
      report: compareShifts(sources.jiraIssues, sources.supabaseRows, sources.mapping),
    };
  } catch (error) {
    const failure = error instanceof VerificationFailure
      ? error
      : new VerificationFailure("jira", "connectivity", "The verification check failed unexpectedly.");
    return {
      ok: false,
      failure: {
        provider: failure.provider,
        category: failure.category,
        message: failure.message,
      },
    };
  }
}

export async function syncLiveShifts(): Promise<LiveSyncResult> {
  try {
    const sources = await loadLiveShiftSources();
    const jiraNormalized = normalizeRecords("jira", sources.jiraIssues, sources.mapping);
    if (
      jiraNormalized.issues.length
      || jiraNormalized.duplicateIdentifiers.length
      || jiraNormalized.missingStableIdentifiers
    ) {
      throw new VerificationFailure(
        "jira",
        "malformed",
        `Jira SHIFT contains ${jiraNormalized.issues.length} malformed records or duplicate/missing identifiers; no rows were written.`,
      );
    }
    const rows = sources.jiraIssues.map((issue) => buildSupabaseRow(issue, sources));
    await upsertSupabaseRows(sources.supabase, sources.mapping, rows);
    const updatedSupabaseRows = await listSupabaseRows(sources.supabase, sources.mapping);
    return {
      ok: true,
      syncedCount: rows.length,
      mapping: sources.mapping,
      report: compareShifts(sources.jiraIssues, updatedSupabaseRows, sources.mapping),
    };
  } catch (error) {
    const failure = error instanceof VerificationFailure
      ? error
      : new VerificationFailure("supabase", "connectivity", "The shift sync failed unexpectedly.");
    return {
      ok: false,
      failure: {
        provider: failure.provider,
        category: failure.category,
        message: failure.message,
      },
    };
  }
}

function failureStatus(category: FailureCategory): string {
  if (category === "schema") return "SCHEMA_MAPPING_ERROR";
  if (category === "malformed") return "MALFORMED_SOURCE";
  return `${category.toUpperCase()}_FAILURE`;
}

function printReport(result: LiveVerificationResult): void {
  console.log("Jira SHIFT ↔ Supabase public.shifts verification");
  if (!result.ok) {
    console.log(`status: ${failureStatus(result.failure.category)}`);
    console.log(`provider: ${result.failure.provider}`);
    console.log(`diagnostic: ${result.failure.message}`);
    return;
  }
  printReconciliationReport(result.report);
}

export function printReconciliationReport(report: ReconciliationReport): void {
  console.log(`status: ${report.status}`);
  console.log(`jira issues: ${report.jiraCount}`);
  console.log(`supabase rows: ${report.supabaseCount}`);
  console.log(`matched identifiers: ${report.matchedCount}`);
  console.log(`jira-only rows: ${report.jiraOnly.length}`);
  console.log(`supabase-only rows: ${report.supabaseOnly.length}`);
  console.log(`duplicate identifiers: Jira ${report.duplicateIdentifiers.jira.length}; Supabase ${report.duplicateIdentifiers.supabase.length}`);
  console.log(`missing stable identifiers: Jira ${report.missingStableIdentifiers.jira}; Supabase ${report.missingStableIdentifiers.supabase}`);
  console.log(`malformed source records: Jira ${report.malformedRecords.jira}; Supabase ${report.malformedRecords.supabase}`);
  console.log(`field mismatches: ${report.fieldMismatches.length}`);
  console.log(`timestamp mismatches: ${report.timestampMismatches.length}`);
  console.log(`stale updates: ${report.staleUpdates.length}`);
  if (report.status === "MISMATCH") {
    console.log("diagnostic: reconciliation failed; inspect the source data and mapping before enabling sync.");
  } else if (report.status === "EMPTY_REACHABLE") {
    console.log("diagnostic: both sources are reachable and empty; no shift feed is present yet.");
  } else {
    console.log("diagnostic: Jira and Supabase shift feeds are consistent.");
  }
}

function printSyncReport(result: LiveSyncResult): void {
  console.log("Jira SHIFT → Supabase public.shifts sync");
  if (!result.ok) {
    console.log(`status: ${failureStatus(result.failure.category)}`);
    console.log(`provider: ${result.failure.provider}`);
    console.log(`diagnostic: ${result.failure.message}`);
    return;
  }
  console.log(`synced Jira issues: ${result.syncedCount}`);
  printReconciliationReport(result.report);
}

export async function main(): Promise<void> {
  const result = await verifyLiveShiftSync();
  printReport(result);
  if (!result.ok || result.report.status === "MISMATCH") process.exitCode = 1;
}

export async function syncMain(): Promise<void> {
  const result = await syncLiveShifts();
  printSyncReport(result);
  if (!result.ok || result.report.status === "MISMATCH") process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}