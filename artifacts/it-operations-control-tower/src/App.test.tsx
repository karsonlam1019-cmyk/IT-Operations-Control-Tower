// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaffPage } from "./App";

const initialStaff = {
  id: "s-001",
  name: "Maya Chen",
  initials: "MC",
  role: "Incident Commander",
  team: "Stale Coverage",
  region: "HK",
  status: "Away",
  ticket: "SHIFT-1001",
  environment: "PROD",
  eta: "42 min",
  updatedAt: "2026-08-30T12:00:00.000Z",
  isStale: true,
};

const refreshedStaff = {
  ...initialStaff,
  team: "Platform Reliability",
  status: "Active",
  updatedAt: "2026-08-30T12:05:00.000Z",
  isStale: false,
};

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("StaffPage Jira sync", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("refreshes the staff query after a successful sync", async () => {
    let staff = [initialStaff];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/staff/sync-jira") {
        staff = [refreshedStaff];
        return jsonResponse({ count: 1 });
      }
      if (path === "/api/staff") {
        return jsonResponse(staff);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <StaffPage />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Stale Coverage")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("button-sync-jira"));

    await waitFor(() =>
      expect(screen.getByText("Platform Reliability")).toBeInTheDocument(),
    );
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          String(input) === "/api/staff" && init?.method === "GET",
      ),
    ).toHaveLength(2);
  });

  it.each([
    [
      "CONFIGURATION",
      "Jira sync is not configured. Ask an administrator to configure the server integration.",
      "Missing required environment variables: JIRA_API_TOKEN",
    ],
    [
      "JIRA",
      "Jira is unavailable. Check Jira status and try again.",
      "Jira API request failed with 502 Bad Gateway: provider response details",
    ],
    [
      "SUPABASE",
      "Shift data could not be saved. Check the data service and try again.",
      "Supabase shifts upsert failed: connection refused",
    ],
  ])("shows a safe actionable message for %s sync failures", async (category, message, rawDetail) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/staff/sync-jira") {
        return jsonResponse({
          error: "Jira shift sync failed; check the integration logs",
          code: "JIRA_SYNC_UNAVAILABLE",
          category,
          detail: rawDetail,
        }, 503);
      }
      if (path === "/api/staff") {
        return jsonResponse([initialStaff]);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <StaffPage />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Stale Coverage")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("button-sync-jira"));

    const syncError = await screen.findByTestId("sync-error");
    expect(syncError).toHaveTextContent(message);
    expect(syncError).not.toHaveTextContent(rawDetail);
    expect(syncError).toHaveTextContent("Retry");
  });
});