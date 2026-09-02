import assert from "node:assert/strict";
import test from "node:test";
import { compareShifts, type ShiftMapping } from "./shift-sync";

const mapping: ShiftMapping = {
  identifier: { supabaseColumn: "jira_issue_key", jiraField: "key" },
  fields: {
    staffMember: { supabaseColumn: "staff_member", jiraField: "staff_member" },
    team: { supabaseColumn: "team", jiraField: "team" },
    region: { supabaseColumn: "region", jiraField: "region" },
    environment: { supabaseColumn: "environment", jiraField: "environment" },
    signal: { supabaseColumn: "signal", jiraField: "signal" },
    action: { supabaseColumn: "action", jiraField: "status" },
    processStatus: { supabaseColumn: "Process_Status", jiraField: "status_ticket" },
    priority: { supabaseColumn: "priority", jiraField: "priority" },
    dueDate: { supabaseColumn: "due_date", jiraField: "duedate" },
  },
  updatedAt: { supabaseColumn: "jira_updated_at", jiraField: "updated" },
};

function jiraIssue(
  key: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: key.replace("SHIFT-", ""),
    key,
    fields: {
      staff_member: "Maya Chen",
      team: "Platform Reliability",
      region: "HK",
      environment: "PROD",
      signal: "Live",
      status: { name: "In Progress" },
      status_ticket: "Open",
      priority: { name: "High" },
      duedate: "2026-09-15",
      updated: "2026-09-02T08:00:00Z",
      ...overrides,
    },
  };
}

function supabaseRow(
  key: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    jira_issue_key: key,
    staff_member: "Maya Chen",
    team: "Platform Reliability",
    region: "HK",
    environment: "PROD",
    signal: "Live",
    action: "In Progress",
    Process_Status: "Open",
    priority: "High",
    due_date: "2026-09-15",
    jira_updated_at: "2026-09-02T08:00:00Z",
    ...overrides,
  };
}

test("passes matching normalized rows", () => {
  const report = compareShifts(
    [jiraIssue("SHIFT-1")],
    [supabaseRow("SHIFT-1")],
    mapping,
  );
  assert.equal(report.status, "PASS");
  assert.equal(report.matchedCount, 1);
  assert.equal(report.fieldMismatches.length, 0);
  assert.equal(report.timestampMismatches.length, 0);
});

test("reports Jira-only and Supabase-only rows", () => {
  const report = compareShifts(
    [jiraIssue("SHIFT-1"), jiraIssue("SHIFT-2")],
    [supabaseRow("SHIFT-1"), supabaseRow("SHIFT-3")],
    mapping,
  );
  assert.equal(report.status, "MISMATCH");
  assert.deepEqual(report.jiraOnly, ["shift-2"]);
  assert.deepEqual(report.supabaseOnly, ["shift-3"]);
});

test("reports duplicate stable identifiers", () => {
  const report = compareShifts(
    [jiraIssue("SHIFT-1"), jiraIssue("SHIFT-1")],
    [supabaseRow("SHIFT-1")],
    mapping,
  );
  assert.equal(report.status, "MISMATCH");
  assert.deepEqual(report.duplicateIdentifiers.jira, ["shift-1"]);
});

test("reports duplicate Supabase stable identifiers", () => {
  const report = compareShifts(
    [jiraIssue("SHIFT-1")],
    [supabaseRow("SHIFT-1"), supabaseRow("SHIFT-1")],
    mapping,
  );
  assert.equal(report.status, "MISMATCH");
  assert.deepEqual(report.duplicateIdentifiers.supabase, ["shift-1"]);
});

test("reports missing stable identifiers", () => {
  const report = compareShifts(
    [jiraIssue("SHIFT-1"), jiraIssue("")],
    [supabaseRow("SHIFT-1")],
    mapping,
  );
  assert.equal(report.status, "MISMATCH");
  assert.equal(report.missingStableIdentifiers.jira, 1);
});

test("reports mapped field mismatches", () => {
  const report = compareShifts(
    [jiraIssue("SHIFT-1", { signal: "Away", status_ticket: "In Progress" })],
    [supabaseRow("SHIFT-1")],
    mapping,
  );
  assert.equal(report.fieldMismatches.length, 2);
  assert.deepEqual(
    report.fieldMismatches.map((mismatch) => mismatch.field),
    ["signal", "processStatus"],
  );
});

test("reports stale updates and timestamp mismatches", () => {
  const report = compareShifts(
    [jiraIssue("SHIFT-1", { updated: "2026-09-02T07:00:00Z", signal: "Away" })],
    [supabaseRow("SHIFT-1")],
    mapping,
  );
  assert.equal(report.timestampMismatches.length, 1);
  assert.equal(report.staleUpdates[0]?.staleSide, "jira");
  assert.equal(report.fieldMismatches[0]?.field, "signal");
});

test("reports malformed source records", () => {
  const report = compareShifts(
    [jiraIssue("SHIFT-1", { updated: "not-a-time" }), null],
    [supabaseRow("SHIFT-1")],
    mapping,
  );
  assert.equal(report.status, "MISMATCH");
  assert.equal(report.jiraCount, 2);
  assert.equal(report.malformedRecords.jira, 2);
});

test("distinguishes two reachable empty sources", () => {
  const report = compareShifts([], [], mapping);
  assert.equal(report.status, "EMPTY_REACHABLE");
});