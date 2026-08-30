import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { syncJiraShifts } from "./jiraSync.js";

const TEST_ENVIRONMENT = {
  SUPABASE_URL: "https://example.supabase.co/rest/v1",
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
          fields: {
            assignee: { accountId: "staff-1" },
            status: { name: "Active" },
            updated: "2026-08-30T12:00:00.000+0000",
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
    'project = "SHIFT" AND updated >= -10m',
  );
  assert.equal(
    requests[0].url.searchParams.get("fields"),
    "assignee,status,updated",
  );
  assert.deepEqual(upsertCall, {
    rows: [
      {
        jira_issue_id: "10001",
        staff_id: "staff-1",
        shift_status: "Active",
        updated_at: "2026-08-30T12:00:00.000Z",
      },
    ],
    options: { onConflict: "jira_issue_id" },
  });
});
