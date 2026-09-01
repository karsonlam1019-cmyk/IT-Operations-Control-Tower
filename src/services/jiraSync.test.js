import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { syncJiraShifts } from "./jiraSync.js";

const TEST_ENVIRONMENT = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  JIRA_HOST: "https://example.atlassian.net/",
  JIRA_EMAIL: "test@example.com",
  JIRA_API_TOKEN: "test-api-token",
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
    fetchImpl: async () => jsonResponse({ issues: [], isLast: true }),
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

test("fetches SHIFT issues and upserts the mapped shifts", async () => {
  const requests = [];
  const responses = [
    {
      issues: [
        {
          id: "10001",
          key: "SHIFT-10001",
          fields: {
            customfield_10064: { id: "10001", value: "Staff One" },
            customfield_10065: { id: "10002", value: "Platform Reliability" },
            customfield_10066: { id: "10003", value: "HK" },
            customfield_10067: { id: "10004", value: "PROD" },
            status: { name: "Active" },
            updated: "2026-08-30T12:00:00.000+0000",
            duedate: "2026-09-05",
          },
        },
      ],
    },
  ];
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
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.pathname, "/rest/api/3/search");
  assert.equal(requests[0].url.origin, "https://example.atlassian.net");
  assert.equal(
    requests[0].options.headers.Authorization,
    `Basic ${Buffer.from(
      `${TEST_ENVIRONMENT.JIRA_EMAIL}:${TEST_ENVIRONMENT.JIRA_API_TOKEN}`,
    ).toString("base64")}`,
  );
  assert.equal(
    requests[0].url.searchParams.get("jql"),
    'project = "SHIFT" ORDER BY updated DESC',
  );
  assert.equal(
    requests[0].url.searchParams.get("fields"),
    "summary,status,updated,duedate,customfield_10064,customfield_10065,customfield_10066,customfield_10067",
  );
  assert.deepEqual(upsertCall, {
    rows: [
      {
        jira_issue_key: "SHIFT-10001",
        staff_member: "Staff One",
        team: "Platform Reliability",
        region: "HK",
        environment: "PROD",
        signal: "Active",
        action: null,
        due_date: "2026-09-05",
        jira_updated_at: "2026-08-30T12:00:00.000Z",
        last_synced_at: upsertCall.rows[0].last_synced_at,
      },
    ],
    options: { onConflict: "jira_issue_key" },
  });
  assert.match(upsertCall.rows[0].last_synced_at, /^\d{4}-\d{2}-\d{2}T/);
});
