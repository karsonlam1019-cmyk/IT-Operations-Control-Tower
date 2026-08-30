import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/services/jiraSync.js", () => ({
  syncJiraShifts: vi.fn(),
}));

import app from "../app";
// @ts-ignore The standalone JavaScript service is shared with the sync runner.
import { syncJiraShifts } from "../../../../src/services/jiraSync.js";

const mockedSyncJiraShifts = vi.mocked(syncJiraShifts);

async function startServer() {
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function postSync() {
  const { server, url } = await startServer();
  try {
    const response = await fetch(`${url}/api/staff/sync-jira`, {
      method: "POST",
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  } finally {
    await new Promise<void>((resolve, reject) => {
      (server as Server).close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("POST /api/staff/sync-jira", () => {
  beforeEach(() => {
    mockedSyncJiraShifts.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the synchronizer result when the sync succeeds", async () => {
    mockedSyncJiraShifts.mockResolvedValue({ count: 4 });

    const result = await postSync();

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ count: 4 });
    expect(mockedSyncJiraShifts).toHaveBeenCalledOnce();
  });

  it("returns a service-unavailable error when server configuration is missing", async () => {
    mockedSyncJiraShifts.mockRejectedValue(
      new Error(
        "Missing required environment variables: SUPABASE_URL, JIRA_API_TOKEN",
      ),
    );

    const result = await postSync();

    expect(result.status).toBe(503);
    expect(result.body).toEqual({
      error: "Jira shift sync is not configured on the server",
      code: "JIRA_SYNC_UNAVAILABLE",
    });
  });

  it("turns Jira failures into an explicit non-success response", async () => {
    mockedSyncJiraShifts.mockRejectedValue(
      new Error("Jira API request failed with 502 Bad Gateway"),
    );

    const result = await postSync();

    expect(result.status).toBe(503);
    expect(result.body).toEqual({
      error: "Jira shift sync failed; check the integration logs",
      code: "JIRA_SYNC_UNAVAILABLE",
    });
  });

  it("turns Supabase failures into an explicit non-success response", async () => {
    mockedSyncJiraShifts.mockRejectedValue(
      new Error("Supabase shifts upsert failed: connection refused"),
    );

    const result = await postSync();

    expect(result.status).toBe(503);
    expect(result.body).toEqual({
      error: "Jira shift sync failed; check the integration logs",
      code: "JIRA_SYNC_UNAVAILABLE",
    });
  });
});