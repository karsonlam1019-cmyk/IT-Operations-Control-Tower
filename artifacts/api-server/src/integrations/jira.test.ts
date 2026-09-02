import { afterEach, describe, expect, it, vi } from "vitest";
import { listJiraTickets } from "./jira";

const environmentKeys = [
  "JIRA_HOST",
  "JIRA_BASE_URL",
  "JIRA_EMAIL",
  "JIRA_API_TOKEN",
  "JIRA_PROJECT_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

describe("Jira work queue mapping", () => {
  const originalEnvironment = Object.fromEntries(
    environmentKeys.map((key) => [key, process.env[key]]),
  );

  afterEach(() => {
    for (const key of environmentKeys) {
      const value = originalEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.unstubAllGlobals();
  });

  it("maps named Jira fields and excludes Completed work", async () => {
    delete process.env.JIRA_HOST;
    process.env.JIRA_BASE_URL = "https://jira.example.com/";
    process.env.JIRA_EMAIL = "jira@example.com";
    process.env.JIRA_API_TOKEN = "test-token";
    process.env.JIRA_PROJECT_KEY = "SHIFT";
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/rest/api/3/field")) {
        return new Response(JSON.stringify([
          { id: "customfield_10064", name: "Staff Member" },
          { id: "customfield_10067", name: "Environment" },
          { id: "customfield_10068", name: "Work" },
          { id: "customfield_10069", name: "Status_Ticket" },
        ]), { status: 200 });
      }
      if (url.includes("/rest/api/3/search/jql?")) {
        return new Response(JSON.stringify({
          issues: [
            {
              id: "1",
              key: "SHIFT-1",
              fields: {
                customfield_10064: { value: "Maya Chen" },
                customfield_10067: { value: "PROD" },
                customfield_10068: "Restore payment gateway",
                customfield_10069: { value: "In Progress" },
                status: { name: "Open" },
                updated: "2026-09-01T08:00:00.000Z",
              },
            },
            {
              id: "2",
              key: "SHIFT-2",
              fields: {
                customfield_10064: { value: "Ethan Wong" },
                customfield_10067: { value: "UAT" },
                customfield_10068: "Completed release",
                customfield_10069: { value: "Completed" },
                status: { name: "Done" },
                updated: "2026-09-01T07:00:00.000Z",
              },
            },
          ],
        }), { status: 200 });
      }
      throw new Error(`Unexpected Jira request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const feed = await listJiraTickets();

    expect(feed.source).toBe("jira");
    expect(feed.tickets).toEqual([{
      id: "1",
      key: "SHIFT-1",
      summary: "Restore payment gateway",
      status: "In Progress",
      assignee: "Maya Chen",
      environment: "PROD",
      updatedAt: "2026-09-01T08:00:00.000Z",
    }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/rest/api/3/search/jql?");
  });
});