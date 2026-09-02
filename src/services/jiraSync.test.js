import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { syncJiraShifts } from "./jiraSync.js";

const TEST_ENVIRONMENT = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  JIRA_HOST: "https://example.atlassian.net/",
  JIRA_BASE_URL: undefined,
  JIRA_EMAIL: "test@example.com",
  JIRA_API_TOKEN: "test-api-token",
  JIRA_PROJECT_KEY: "IT",
  JIRA_STAFF_MEMBER_FIELD: undefined,
  JIRA_STAFF_FIELD: undefined,
  JIRA_TEAM_FIELD: undefined,
  JIRA_REGION_FIELD: undefined,
  JIRA_ENVIRONMENT_FIELD: undefined,
  JIRA_SIGNAL_FIELD: undefined,
  JIRA_STATUS_TICKET_FIELD: undefined,
  JIRA_ACTION_FIELD: undefined,
};

let previousEnvironment;

beforeEach(() => {
  previousEnvironment = Object.fromEntries(
    Object.keys(TEST_ENVIRONMENT).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, TEST_ENVIRONMENT);
});

afterEach(() => {
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

function jsonResponse(payload) {
  return {
    ok: true,
    json: async () => payload,
  };
}

test("returns zero without calling Supabase when Jira has no updated issues", async () => {
  let supabaseTableAccessed = false;
  const result = await syncJiraShifts({
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      if (path === "/rest/api/3/field") return jsonResponse([]);
      assert.equal(path, "/rest/api/3/search/jql");
      return jsonResponse({ issues: [] });
    },
    createSupabaseClient: () => ({
      from() {
        supabaseTableAccessed = true;
        throw new Error(
          "Supabase should not be called for an empty Jira result",
        );
      },
    }),
  });

  assert.deepEqual(result, { count: 0 });
  assert.equal(supabaseTableAccessed, false);
});

test("uses the configured project, enhanced JQL endpoint, and discovered fields", async () => {
  const requests = [];
  const responses = [
    [
      { id: "customfield_20001", name: "Staff Member" },
      { id: "customfield_20002", name: "Team01" },
      { id: "customfield_20003", name: "Region" },
      { id: "customfield_20004", name: "Environment" },
      { id: "customfield_20005", name: "Signal" },
      { id: "customfield_20006", name: "Action" },
    ],
    {
      issues: [
        {
          id: "10001",
          key: "OPS-10001",
          fields: {
            customfield_20001: { id: "10001", value: "Staff One" },
            customfield_20002: { id: "10002", value: "Platform Reliability" },
            customfield_20003: { id: "10003", value: "HK" },
            customfield_20004: { id: "10004", value: "PROD" },
            customfield_20005: { id: "10005", value: "Active" },
            customfield_20006: "Page the incident commander",
            status: { name: "Open" },
            updated: "2026-08-30T12:00:00.000+0000",
            duedate: "2026-09-05",
          },
        },
      ],
    },
  ];
  delete process.env.JIRA_HOST;
  process.env.JIRA_BASE_URL = "example.atlassian.net/";
  process.env.JIRA_PROJECT_KEY = "OPS";
  let upsertCall;

  const result = await syncJiraShifts({
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options });
      return jsonResponse(responses.shift());
    },
    createSupabaseClient: (url, serviceRoleKey) => {
      assert.equal(url, TEST_ENVIRONMENT.SUPABASE_URL);
      assert.equal(serviceRoleKey, TEST_ENVIRONMENT.SUPABASE_SERVICE_ROLE_KEY);
      return {
        from(table) {
          assert.equal(table, "shifts");
          return {
            async upsert(rows, options) {
              upsertCall = { rows, options };
              return { error: null };
            },
          };
        },
      };
    },
  });

  assert.deepEqual(result, { count: 1 });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url.pathname, "/rest/api/3/field");
  assert.equal(requests[0].url.origin, "https://example.atlassian.net");
  assert.equal(requests[1].url.pathname, "/rest/api/3/search/jql");
  assert.equal(requests[1].url.origin, "https://example.atlassian.net");
  assert.equal(
    requests[1].options.headers.Authorization,
    `Basic ${Buffer.from(
      `${TEST_ENVIRONMENT.JIRA_EMAIL}:${TEST_ENVIRONMENT.JIRA_API_TOKEN}`,
    ).toString("base64")}`,
  );
  assert.equal(
    requests[1].url.searchParams.get("jql"),
    'project = "OPS" ORDER BY updated DESC',
  );
  assert.equal(
    requests[1].url.searchParams.get("fields"),
    "summary,status,updated,duedate,customfield_20001,customfield_20002,customfield_20003,customfield_20004,customfield_20005,customfield_20006",
  );
  assert.deepEqual(upsertCall, {
    rows: [
      {
        jira_issue_key: "OPS-10001",
        staff_member: "Staff One",
        team: "Platform Reliability",
        region: "HK",
        environment: "PROD",
        signal: "Active",
        action: "Page the incident commander",
        due_date: "2026-09-05",
        jira_updated_at: "2026-08-30T12:00:00.000Z",
        last_synced_at: upsertCall.rows[0].last_synced_at,
      },
    ],
    options: { onConflict: "jira_issue_key" },
  });
  assert.match(upsertCall.rows[0].last_synced_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("prefers tenant custom fields and maps Jira status to action", async () => {
  let upsertedRows;

  await syncJiraShifts({
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      if (path === "/rest/api/3/field") {
        return jsonResponse([
          { id: "customfield_10065", name: "Team01" },
          { id: "customfield_10067", name: "Environment" },
          { id: "customfield_10068", name: "Signal" },
          { id: "customfield_10062", name: "Action" },
          { id: "customfield_10071", name: "Status_Ticket" },
          { id: "customfield_10001", name: "Team" },
          { id: "environment", name: "Environment" },
        ]);
      }

      return jsonResponse({
        issues: [
          {
            key: "SHIFT-7",
            fields: {
              customfield_10065: { value: "Application Delivery" },
              customfield_10067: { value: "UAT" },
              customfield_10068: { value: "Inactive" },
              customfield_10062: [],
              customfield_10071: { value: "Open" },
              status: { name: "On-Site Work" },
            },
          },
        ],
      });
    },
    createSupabaseClient: () => ({
      from() {
        return {
          async upsert(rows) {
            upsertedRows = rows;
            return { error: null };
          },
        };
      },
    }),
  });

  assert.equal(upsertedRows[0].team, "Application Delivery");
  assert.equal(upsertedRows[0].environment, "UAT");
  assert.equal(upsertedRows[0].signal, "Inactive");
  assert.equal(upsertedRows[0].action, "On-Site Work");
});

test("reports enhanced Jira failures without reading or exposing provider payloads", async () => {
  const requests = [];
  const sensitivePayload = "provider-secret-token";

  await assert.rejects(
    () =>
      syncJiraShifts({
        fetchImpl: async (url) => {
          const path = new URL(url).pathname;
          requests.push(path);
          if (path === "/rest/api/3/field") return jsonResponse([]);
          return {
            ok: false,
            status: 410,
            statusText: "Gone",
            text: async () => sensitivePayload,
          };
        },
        createSupabaseClient: () => ({
          from() {
            throw new Error("Supabase should not be called after Jira failure");
          },
        }),
      }),
    (error) => {
      assert.equal(error.category, "JIRA");
      assert.equal(error.message, "Jira API issue search failed with 410 Gone");
      assert.equal(error.message.includes(sensitivePayload), false);
      return true;
    },
  );

  assert.deepEqual(requests, ["/rest/api/3/field", "/rest/api/3/search/jql"]);
});

test("categorizes Supabase client and persistence failures safely", async () => {
  await assert.rejects(
    () =>
      syncJiraShifts({
        fetchImpl: async (url) => {
          if (new URL(url).pathname === "/rest/api/3/field") {
            return jsonResponse([{ id: "customfield_1", name: "Staff Member" }]);
          }
          return jsonResponse({
            issues: [{ key: "IT-1", fields: { customfield_1: "Staff One" } }],
          });
        },
        createSupabaseClient: () => {
          throw new Error("connection details must not escape");
        },
      }),
    (error) => {
      assert.equal(error.category, "SUPABASE");
      assert.equal(error.message, "Supabase client initialization failed");
      return true;
    },
  );
});
