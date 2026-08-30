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

  assert.deepEqual(result, { syncedCount: 0 });
  assert.equal(supabaseTableAccessed, false);
});

test("follows enhanced-search pagination and upserts the mapped shifts", async () => {
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
      nextPageToken: "next-page-token",
      isLast: false,
    },
    {
      issues: [
        {
          id: "10002",
          fields: {
            assignee: null,
            status: null,
            updated: "2026-08-30T12:05:00.000+0000",
          },
        },
      ],
      isLast: true,
    },
  ];
  let upsertCall;

  const result = await syncJiraShifts({
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options });
      return jsonResponse(responses.shift());
    },
    createSupabaseClient: (url) => {
      assert.equal(url, "https://example.supabase.co");
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

  assert.deepEqual(result, { syncedCount: 2 });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url.pathname, "/rest/api/3/search/jql");
  assert.equal(requests[0].url.searchParams.get("jql"), "updated >= -10m");
  assert.deepEqual(requests[0].url.searchParams.getAll("fields"), [
    "assignee",
    "status",
    "updated",
  ]);
  assert.equal(
    requests[1].url.searchParams.get("nextPageToken"),
    "next-page-token",
  );
  assert.deepEqual(upsertCall, {
    rows: [
      {
        jira_issue_id: "10001",
        staff_id: "staff-1",
        shift_status: "Active",
        updated_at: "2026-08-30T12:00:00.000+0000",
      },
      {
        jira_issue_id: "10002",
        staff_id: "unassigned",
        shift_status: "unknown",
        updated_at: "2026-08-30T12:05:00.000+0000",
      },
    ],
    options: { onConflict: "jira_issue_id" },
  });
});
