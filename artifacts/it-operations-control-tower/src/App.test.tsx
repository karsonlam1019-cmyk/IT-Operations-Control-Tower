// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("StaffPage Jira sync", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
});