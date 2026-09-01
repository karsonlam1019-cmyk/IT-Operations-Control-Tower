// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getListStaffQueryKey } from "@workspace/api-client-react";
import { DashboardPage, StaffPage } from "./App";

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
    vi.restoreAllMocks();
    cleanup();
  });

  it("shows the focused four-column Shift signal table", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/staff/sync-jira") {
        return jsonResponse({ count: 1 });
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

    expect(await screen.findByText("Maya Chen")).toBeInTheDocument();
    expect(screen.getByText("Staff member")).toBeInTheDocument();
    expect(screen.getByText("Team / region")).toBeInTheDocument();
    expect(screen.getByText("Signal")).toBeInTheDocument();
    expect(screen.getByText("Action")).toBeInTheDocument();
    expect(screen.queryByText("Ticket")).not.toBeInTheDocument();
    expect(screen.queryByText("Environment")).not.toBeInTheDocument();
    expect(screen.queryByText("SHIFT-1001")).not.toBeInTheDocument();
    expect(screen.queryByText("PROD")).not.toBeInTheDocument();
    expect(screen.getByTestId("status-staff-s-001")).toBeInTheDocument();
    expect(screen.getByTestId("button-toggle-status-s-001")).toBeInTheDocument();
  });

  it("refreshes the staff query after a successful sync", async () => {
    let staff = [initialStaff];
    let syncAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/staff/sync-jira") {
        syncAttempts += 1;
        if (syncAttempts === 1) {
          return jsonResponse({
            error: "Jira shift sync failed; check the integration logs",
            code: "JIRA_SYNC_UNAVAILABLE",
            category: "JIRA",
          }, 503);
        }
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

  it("syncs immediately on mount and schedules another sync every five minutes", async () => {
    const intervalCallbacks: Array<() => void> = [];
    const setIntervalSpy = vi.spyOn(window, "setInterval").mockImplementation((...args: Parameters<typeof window.setInterval>) => {
      const [callback, delay] = args;
      if (delay === 300_000) {
        intervalCallbacks.push(callback as () => void);
      }
      return 1 as unknown as ReturnType<typeof window.setInterval>;
    });
    let staff = [initialStaff];
    let syncCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/staff/sync-jira") {
        syncCalls += 1;
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

    expect(await screen.findByText("Platform Reliability")).toBeInTheDocument();
    expect(syncCalls).toBe(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 300_000);

    await act(async () => {
      intervalCallbacks[0]?.();
    });
    await waitFor(() => expect(syncCalls).toBe(2));
  });

  it("derives Active Workforce Ratio from the live Shift signal staff feed", async () => {
    const activeStaff = { ...refreshedStaff, id: "s-004", name: "Active Operator" };
    let staff = [
      refreshedStaff,
      { ...initialStaff, id: "s-002", name: "Away Operator", isStale: false },
      { ...initialStaff, id: "s-003", name: "Stale Operator", status: "Active" },
      activeStaff,
      { ...initialStaff, id: "s-005", name: "Out Of Office Operator", status: "Out of Office", isStale: false },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/staff") {
        return jsonResponse(staff);
      }
      if (path === "/api/dashboard/summary") {
        return jsonResponse({
          systemPulse: 99.94,
          staleStaff: 1,
          pendingApprovals: 0,
          releaseReadiness: 100,
          blockedVariances: 0,
          lastSync: "2026-08-30T12:05:00.000Z",
        });
      }
      if (path === "/api/health") {
        return jsonResponse({ status: "ok" });
      }
      if (path === "/api/jira/tickets") {
        return jsonResponse({
          source: "jira",
          tickets: [
            {
              id: "1001",
              key: "SHIFT-1001",
              summary: "Restore payment gateway",
              status: "In Progress",
              assignee: "Maya Chen",
              environment: "PROD",
              updatedAt: "2026-08-30T12:05:00.000Z",
            },
          ],
        });
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
        <DashboardPage />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("value-system-pulse")).toHaveTextContent("50%"));
    expect(screen.getByText("2 (In-Work) of 4 staff member in office")).toBeInTheDocument();

    staff = staff.map(member => member.status === "Out of Office"
      ? member
      : { ...member, status: "Active", isStale: false });
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: getListStaffQueryKey() });
    });

    await waitFor(() => expect(screen.getByTestId("value-system-pulse")).toHaveTextContent("0%"));
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
    [
      "UNKNOWN",
      "Jira sync failed unexpectedly. Check the integration logs and try again.",
      JSON.stringify({
        status: 502,
        response: "provider response details",
        access_token: "provider-secret-token",
      }),
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