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
      category: "CONFIGURATION",
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
      category: "JIRA",
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
      category: "SUPABASE",
    });
    expect(JSON.stringify(result.body)).not.toContain("connection refused");
  });

  it("uses a safe generic response when the synchronizer throws a non-Error provider payload", async () => {
    const sensitiveProviderPayload = {
      response: {
        status: 401,
        data: {
          error: "invalid_token",
          access_token: "provider-secret-token",
          authorization: "Basic provider-credentials",
        },
      },
    };
    mockedSyncJiraShifts.mockRejectedValue(sensitiveProviderPayload);

    const result = await postSync();

    expect(result.status).toBe(503);
    expect(result.body).toEqual({
      error: "Jira shift sync failed; check the integration logs",
      code: "JIRA_SYNC_UNAVAILABLE",
      category: "UNKNOWN",
    });
    expect(JSON.stringify(result.body)).not.toContain("provider-secret-token");
    expect(JSON.stringify(result.body)).not.toContain("provider-credentials");
    expect(JSON.stringify(result.body)).not.toContain("invalid_token");
  });

  it("does not classify an unrecognized Error by leaking its provider payload", async () => {
    const providerPayload = JSON.stringify({
      status: 502,
      response: "upstream details",
      access_token: "provider-secret-token",
    });
    mockedSyncJiraShifts.mockRejectedValue(
      new Error(`Unexpected synchronizer failure: ${providerPayload}`),
    );

    const result = await postSync();

    expect(result.body).toEqual({
      error: "Jira shift sync failed; check the integration logs",
      code: "JIRA_SYNC_UNAVAILABLE",
      category: "UNKNOWN",
    });
    expect(JSON.stringify(result.body)).not.toContain("upstream details");
    expect(JSON.stringify(result.body)).not.toContain("provider-secret-token");
  });
});