const MAX_RESULTS = 100;
const JIRA_REQUEST_TIMEOUT_MS = 5_000;

const FIELD_ALIASES = {
  staffMember: ["staff member", "staff"],
  team: ["team01", "team"],
  region: ["region"],
  environment: ["environment", "target environment"],
  signal: ["signal", "status ticket", "status"],
  action: ["action"],
};

const FIELD_ENVIRONMENT_KEYS = {
  staffMember: ["JIRA_STAFF_MEMBER_FIELD", "JIRA_STAFF_FIELD"],
  team: ["JIRA_TEAM_FIELD"],
  region: ["JIRA_REGION_FIELD"],
  environment: ["JIRA_ENVIRONMENT_FIELD"],
  signal: ["JIRA_SIGNAL_FIELD", "JIRA_STATUS_TICKET_FIELD"],
  action: ["JIRA_ACTION_FIELD"],
};

export class JiraSyncError extends Error {
  constructor(message, category = "JIRA") {
    super(message);
    this.name = "JiraSyncError";
    this.category = category;
  }
}

function readEnvironmentValue(name) {
  const value = process.env[name];
  if (
    !value ||
    value.trim() === "" ||
    ["undefined", "null"].includes(value.trim().toLowerCase()) ||
    value.toUpperCase().includes("PASTE") ||
    value.toUpperCase().includes("YOUR_")
  ) {
    return undefined;
  }
  return value.trim();
}

function getRequiredEnvironment() {
  const environment = {
    supabaseUrl:
      readEnvironmentValue("SUPABASE_J_URL") ??
      readEnvironmentValue("SUPABASE_URL"),
    supabaseServiceRoleKey:
      readEnvironmentValue("SUPABASE_J_SERVICE_ROLE_KEY") ??
      readEnvironmentValue("SUPABASE_SERVICE_ROLE_KEY"),
    jiraBaseUrl:
      readEnvironmentValue("JIRA_HOST") ??
      readEnvironmentValue("JIRA_BASE_URL"),
    jiraEmail: readEnvironmentValue("JIRA_EMAIL"),
    jiraApiToken: readEnvironmentValue("JIRA_API_TOKEN"),
    jiraProjectKey: readEnvironmentValue("JIRA_PROJECT_KEY") ?? "IT",
  };

  const missing = [];
  if (!environment.supabaseUrl) {
    missing.push("SUPABASE_J_URL or SUPABASE_URL");
  }
  if (!environment.supabaseServiceRoleKey) {
    missing.push("SUPABASE_J_SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY");
  }
  if (!environment.jiraBaseUrl) missing.push("JIRA_HOST or JIRA_BASE_URL");
  if (!environment.jiraEmail) missing.push("JIRA_EMAIL");
  if (!environment.jiraApiToken) missing.push("JIRA_API_TOKEN");

  if (missing.length > 0) {
    throw new JiraSyncError(
      `Missing required environment variables: ${missing.join(", ")}`,
      "CONFIGURATION",
    );
  }

  return environment;
}

function normalizeJiraBaseUrl(value) {
  const withoutTrailingSlash = value.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(withoutTrailingSlash)
    ? withoutTrailingSlash
    : `https://${withoutTrailingSlash}`;
}

function createSupabaseRestClient(baseUrl, serviceRoleKey) {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "").replace(/\/rest\/v1$/i, "");
  return {
    from(table) {
      return {
        async upsert(rows, { onConflict } = {}) {
          const query = onConflict
            ? `?on_conflict=${encodeURIComponent(onConflict)}`
            : "";
          const response = await fetch(
            `${normalizedBaseUrl}/rest/v1/${encodeURIComponent(table)}${query}`,
            {
              method: "POST",
              headers: {
                apikey: serviceRoleKey,
                Authorization: `Bearer ${serviceRoleKey}`,
                "Content-Type": "application/json",
                Prefer: "resolution=merge-duplicates,return=minimal",
              },
              body: JSON.stringify(rows),
              signal: AbortSignal.timeout(JIRA_REQUEST_TIMEOUT_MS),
            },
          );
          if (response.ok) return { error: null };
          const detail = await response.text().catch(() => "");
          return {
            error: new Error(
              `Supabase returned ${response.status}${detail ? `: ${detail}` : ""}`,
            ),
          };
        },
      };
    },
  };
}

function normalizeFieldName(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function jiraFieldValue(value) {
  if (Array.isArray(value)) {
    return value.map(jiraFieldValue).filter(Boolean).join(", ");
  }
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const field = value;
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

function getConfiguredFieldId(fieldKey, fieldIdsByName) {
  const configuredValue = FIELD_ENVIRONMENT_KEYS[fieldKey]
    .map((name) => readEnvironmentValue(name))
    .find(Boolean);

  if (configuredValue) {
    const configuredName = normalizeFieldName(configuredValue);
    return (
      fieldIdsByName.get(configuredName) ??
      (configuredValue.startsWith("customfield_") ? configuredValue : undefined)
    );
  }

  return FIELD_ALIASES[fieldKey]
    .map(normalizeFieldName)
    .map((name) => fieldIdsByName.get(name))
    .find(Boolean);
}

function createAuthorizationHeader(email, apiToken) {
  return `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
}

async function fetchJira(
  url,
  options,
  fetchImpl,
  timeoutMs = JIRA_REQUEST_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    const message =
      error?.name === "AbortError"
        ? "Provider request timed out"
        : "Provider request could not be completed";
    throw new JiraSyncError(`Jira API request failed: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function requireSuccessfulJiraResponse(response, operation) {
  if (response.ok) return response;

  throw new JiraSyncError(
    `Jira API ${operation} failed with ${response.status} ${response.statusText || "Unknown status"}`,
  );
}

async function discoverJiraFields({ baseUrl, headers, fetchImpl }) {
  const response = await fetchJira(
    `${baseUrl}/rest/api/3/field`,
    { headers },
    fetchImpl,
  );
  await requireSuccessfulJiraResponse(response, "field discovery");

  let fields;
  try {
    fields = await response.json();
  } catch {
    throw new JiraSyncError("Jira API field discovery returned invalid JSON");
  }

  if (!Array.isArray(fields)) {
    throw new JiraSyncError("Jira API field discovery returned an invalid payload");
  }

  const fieldIdsByName = new Map();
  for (const field of fields) {
    if (
      !field ||
      typeof field !== "object" ||
      typeof field.id !== "string" ||
      typeof field.name !== "string"
    ) {
      continue;
    }

    const normalizedName = normalizeFieldName(field.name);
    const currentId = fieldIdsByName.get(normalizedName);
    const isCustomField = field.id.startsWith("customfield_");
    const currentIsCustomField = currentId?.startsWith("customfield_") ?? false;

    if (!currentId || (isCustomField && !currentIsCustomField)) {
      fieldIdsByName.set(normalizedName, field.id);
    }
  }

  return fieldIdsByName;
}

function toIsoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function mapJiraIssue(issue, fieldIds, syncedAt) {
  if (!issue || typeof issue !== "object" || !issue.key) return null;

  const fields = issue.fields && typeof issue.fields === "object"
    ? issue.fields
    : {};
  const getCustomField = (fieldKey) =>
    fieldIds[fieldKey] ? jiraFieldValue(fields[fieldIds[fieldKey]]) : "";
  const signal = getCustomField("signal") || jiraFieldValue(fields.status);
  const action = getCustomField("action") || jiraFieldValue(fields.status);

  return {
    jira_issue_key: String(issue.key),
    staff_member: getCustomField("staffMember") || "Unassigned",
    team: getCustomField("team") || null,
    region: getCustomField("region") || null,
    environment: getCustomField("environment") || null,
    signal: signal || "Unknown",
    action: action || null,
    due_date: typeof fields.duedate === "string" ? fields.duedate : null,
    jira_updated_at: toIsoDate(fields.updated),
    last_synced_at: syncedAt,
  };
}

async function getJiraIssues({
  baseUrl,
  projectKey,
  headers,
  fetchImpl,
}) {
  const fieldIdsByName = await discoverJiraFields({
    baseUrl,
    headers,
    fetchImpl,
  });
  const fieldIds = Object.fromEntries(
    Object.keys(FIELD_ALIASES)
      .map((fieldKey) => [
        fieldKey,
        getConfiguredFieldId(fieldKey, fieldIdsByName),
      ])
      .filter(([, fieldId]) => Boolean(fieldId)),
  );

  const requestedFields = [
    "summary",
    "status",
    "updated",
    "duedate",
    ...Object.values(fieldIds),
  ];
  const searchParams = new URLSearchParams({
    jql: `project = "${projectKey.replaceAll('"', '\\"')}" ORDER BY updated DESC`,
    fields: [...new Set(requestedFields)].join(","),
    maxResults: String(MAX_RESULTS),
  });

  const response = await fetchJira(
    `${baseUrl}/rest/api/3/search/jql?${searchParams}`,
    { headers },
    fetchImpl,
  );
  await requireSuccessfulJiraResponse(response, "issue search");

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new JiraSyncError("Jira API issue search returned invalid JSON");
  }

  if (!payload || !Array.isArray(payload.issues)) {
    throw new JiraSyncError("Jira API issue search returned an invalid payload");
  }

  return {
    issues: payload.issues,
    fieldIds,
  };
}

export async function syncJiraShifts({
  fetchImpl = fetch,
  createSupabaseClient = createSupabaseRestClient,
} = {}) {
  const {
    supabaseUrl,
    supabaseServiceRoleKey,
    jiraBaseUrl,
    jiraEmail,
    jiraApiToken,
    jiraProjectKey,
  } = getRequiredEnvironment();

  let supabase;
  try {
    supabase = createSupabaseClient(supabaseUrl, supabaseServiceRoleKey);
  } catch {
    throw new JiraSyncError(
      "Supabase client initialization failed",
      "SUPABASE",
    );
  }
  const normalizedJiraBaseUrl = normalizeJiraBaseUrl(jiraBaseUrl);
  const headers = {
    Authorization: createAuthorizationHeader(jiraEmail, jiraApiToken),
    Accept: "application/json",
  };

  console.log(
    `[jira-sync] Fetching Jira issues from project ${jiraProjectKey}...`,
  );

  const { issues, fieldIds } = await getJiraIssues({
    baseUrl: normalizedJiraBaseUrl,
    projectKey: jiraProjectKey,
    headers,
    fetchImpl,
  });
  const syncedAt = new Date().toISOString();
  const rows = issues
    .map((issue) => mapJiraIssue(issue, fieldIds, syncedAt))
    .filter(Boolean);

  console.log(`[jira-sync] Received ${rows.length} Jira issue(s)`);

  if (rows.length === 0) {
    console.log("[jira-sync] No shifts to upsert");
    return { count: 0 };
  }

  try {
    const { error } = await supabase
      .from("shifts")
      .upsert(rows, { onConflict: "jira_issue_key" });

    if (error) {
      throw new JiraSyncError("Supabase shifts upsert failed", "SUPABASE");
    }
  } catch (error) {
    if (error instanceof JiraSyncError) throw error;
    throw new JiraSyncError("Supabase shifts upsert failed", "SUPABASE");
  }

  console.log(`[jira-sync] Successfully upserted ${rows.length} shift(s)`);
  return { count: rows.length };
}