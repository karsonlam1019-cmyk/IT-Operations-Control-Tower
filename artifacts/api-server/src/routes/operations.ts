import { Router, type IRouter } from "express";
import {
  AdvanceProcurementStatusBody,
  AdvanceProcurementStatusParams,
  AdvanceProcurementStatusResponse,
  ApproveProcurementParams,
  ApproveProcurementResponse,
  CreatePaymentScheduleBody,
  CreatePaymentScheduleParams,
  CreatePaymentScheduleResponse,
  CreateProcurementRecordBody,
  CreateProcurementRecordResponse,
  DiscardDlqEntryParams,
  DiscardDlqEntryResponse,
  DualSignoffBody,
  DualSignoffParams,
  DualSignoffResponse,
  GetBudgetSummaryQueryParams,
  GetBudgetSummaryResponse,
  GetDashboardSummaryResponse,
  GetThreeWayMatchParams,
  GetThreeWayMatchResponse,
  GetTreasuryAnalyticsResponse,
  ListAuditLogsResponse,
  ListDlqEntriesQueryParams,
  ListDlqEntriesResponse,
  ListPaymentSchedulesParams,
  ListPaymentSchedulesResponse,
  ListProcurementRecordsResponse,
  ListReleaseGatesResponse,
  ListStaffResponse,
  MarkPaidBody,
  MarkPaidParams,
  MarkPaidResponse,
  ReprocessDlqEntryParams,
  ReprocessDlqEntryResponse,
  ResolveVarianceBody,
  ResolveVarianceParams,
  ResolveVarianceResponse,
  SearchComplianceBody,
  SearchComplianceResponse,
  SubmitInvoiceBody,
  SubmitInvoiceParams,
  SubmitInvoiceResponse,
  SubmitProcurementReviewBody,
  SubmitProcurementReviewParams,
  SubmitProcurementReviewResponse,
  SyncStaffJiraResponse,
  ToggleReleaseGateParams,
  ToggleReleaseGateResponse,
  UpdateStaffStatusBody,
  UpdateStaffStatusParams,
  UpdateStaffStatusResponse,
} from "@workspace/api-zod";
// @ts-ignore The standalone JavaScript service is shared with the sync runner.
import { syncJiraShifts } from "../../../../src/services/jiraSync.js";
import { deepseek } from "../integrations/deepseek";
import {
  approveProcurement,
  advanceProcurementStatus,
  checkBudgetAvailability,
  createPaymentSchedule,
  createProcurementRecord,
  discardDlq,
  dualSignoff,
  getPaymentSchedule,
  getProcurementById,
  getThreeWayMatch,
  listDlq,
  listPaymentSchedules,
  loadBudgetSummary,
  loadDashboardStats,
  loadProcurement,
  loadStaff,
  markPaid,
  reprocessDlq,
  resolveVariance,
  submitInvoice,
  submitReview,
  updateStaffStatus,
} from "../lib/db-runtime";
import {
  CircuitBreaker,
  CircuitOpenError,
  withRetry,
} from "../lib/resilience";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// Circuit breakers for downstream resilience boundaries.
const dbBreaker = new CircuitBreaker("db", 5, 30_000);
const budgetBreaker = new CircuitBreaker("budget-fx", 5, 30_000);

const staff = [
  { id: "s-001", name: "Maya Chen", initials: "MC", role: "Incident Commander", team: "Platform Reliability", region: "HK", status: "On Call - Incidents", ticket: "INC-4821", environment: "PROD", eta: "42 min", updatedAt: "1 min ago", isStale: false },
  { id: "s-002", name: "Ethan Wong", initials: "EW", role: "Release Engineer", team: "Enterprise Apps", region: "HK", status: "Deployment Window", ticket: "REL-2394", environment: "UAT", eta: "1 hr 20 min", updatedAt: "2 min ago", isStale: false },
  { id: "s-003", name: "Aisha Rahman", initials: "AR", role: "Security Analyst", team: "Cyber Defence", region: "MY", status: "Active", ticket: "SEC-8812", environment: "SIT", eta: "3 hr", updatedAt: "6 min ago", isStale: false },
  { id: "s-004", name: "Daniel Lim", initials: "DL", role: "Network Lead", team: "Infrastructure", region: "SG", status: "In Meeting", ticket: "NET-4107", environment: "PROD", eta: "55 min", updatedAt: "11 min ago", isStale: false },
  { id: "s-005", name: "Rina Pratama", initials: "RP", role: "Service Manager", team: "End User Services", region: "ID", status: "Active", ticket: "SR-9271", environment: "STAGING", eta: "2 hr 10 min", updatedAt: "4 hr 18 min ago", isStale: true },
  { id: "s-006", name: "Li Wei", initials: "LW", role: "Database Engineer", team: "Data Platforms", region: "CN", status: "Deployment Window", ticket: "DB-3125", environment: "PROD", eta: "28 min", updatedAt: "3 min ago", isStale: false },
  { id: "s-007", name: "Noor Aziz", initials: "NA", role: "Application Support", team: "Business Systems", region: "MY", status: "Out of Office", ticket: "N/A", environment: "SIT", eta: "Tomorrow", updatedAt: "7 min ago", isStale: false },
  { id: "s-008", name: "Marcus Lau", initials: "ML", role: "Cloud Engineer", team: "Cloud Operations", region: "HK", status: "On Call - Incidents", ticket: "INC-4817", environment: "PROD", eta: "1 hr 5 min", updatedAt: "5 min ago", isStale: false },
];

const releaseGates = [
  { id: "g-01", environment: "SIT", title: "Regression suite passed", owner: "QA Automation", due: "Completed 09:12", checked: true, risk: "Low" },
  { id: "g-02", environment: "SIT", title: "Security scan exceptions reviewed", owner: "Cyber Defence", due: "Completed 09:34", checked: true, risk: "Low" },
  { id: "g-03", environment: "UAT", title: "Business owner sign-off", owner: "Enterprise Apps", due: "Today 15:00", checked: false, risk: "Medium" },
  { id: "g-04", environment: "UAT", title: "Data reconciliation verified", owner: "Data Platforms", due: "Today 16:30", checked: true, risk: "Low" },
  { id: "g-05", environment: "PROD", title: "Rollback plan attached", owner: "Release Engineering", due: "Today 17:00", checked: true, risk: "High" },
  { id: "g-06", environment: "PROD", title: "Change Advisory Board approval", owner: "Head of IT", due: "Today 17:30", checked: false, risk: "Critical" },
];

const procurement = [
  { id: "p-01", prNumber: "PR-2026-0842", poNumber: "PO-2026-0611", vendor: "Nimbus Cloud Services", region: "HK", amount: 428000, currency: "HKD", hkdAmount: 428000, status: "Pending L2 Approval", match: "Matched", createdAt: "28 Aug 2026, 09:18" },
  { id: "p-02", prNumber: "PR-2026-0838", poNumber: "PO-2026-0607", vendor: "Sino Network Systems", region: "CN", amount: 186500, currency: "RMB", hkdAmount: 223800, status: "Variance Blocked", match: "Tax +3.1%", createdAt: "27 Aug 2026, 14:42" },
  { id: "p-03", prNumber: "PR-2026-0831", poNumber: "PO-2026-0599", vendor: "Kuala SecureOps", region: "MY", amount: 92000, currency: "MYR", hkdAmount: 165600, status: "Pending L2 Approval", match: "Matched", createdAt: "26 Aug 2026, 11:03" },
  { id: "p-04", prNumber: "PR-2026-0826", poNumber: "PO-2026-0591", vendor: "Jakarta DataWorks", region: "ID", amount: 840000000, currency: "IDR", hkdAmount: 405600, status: "Payment Approved", match: "Matched", createdAt: "25 Aug 2026, 16:27" },
  { id: "p-05", prNumber: "PR-2026-0819", poNumber: "PO-2026-0583", vendor: "Vertex Managed Services", region: "HK", amount: 780000, currency: "HKD", hkdAmount: 780000, status: "Pending L3 Approval", match: "Matched", createdAt: "24 Aug 2026, 10:15" },
];

const auditLogs = [
  { id: "a-01", actor: "Darren Tam", action: "Approved L2 purchase order", target: "PO-2026-0611", timestamp: "28 Aug 2026, 10:42:18", region: "HK", deputy: false },
  { id: "a-02", actor: "Grace Leung", action: "Activated delegated authority", target: "Head of IT role", timestamp: "28 Aug 2026, 09:58:04", region: "HK", deputy: true },
  { id: "a-03", actor: "Maya Chen", action: "Updated incident status", target: "INC-4821", timestamp: "28 Aug 2026, 09:44:51", region: "HK", deputy: false },
  { id: "a-04", actor: "Finance Control", action: "Blocked payment variance", target: "PO-2026-0607", timestamp: "27 Aug 2026, 16:19:37", region: "CN", deputy: false },
  { id: "a-05", actor: "Ethan Wong", action: "Completed release gate", target: "UAT data reconciliation", timestamp: "27 Aug 2026, 15:52:13", region: "HK", deputy: false },
];

router.get("/dashboard/summary", async (_req, res) => {
  const checked = releaseGates.filter((item) => item.checked).length;
  const db = await loadDashboardStats();
  res.json(GetDashboardSummaryResponse.parse({
    activeStaff: db?.activeStaff ?? 247,
    staleStaff: db?.staleStaff ?? staff.filter((member) => member.isStale).length,
    pendingApprovals: db?.pendingApprovals ?? procurement.filter((item) => item.status.includes("Pending")).length,
    blockedVariances: db?.blockedVariances ?? procurement.filter((item) => item.status.includes("Blocked")).length,
    releaseReadiness: Math.round((checked / releaseGates.length) * 100),
    systemPulse: 99.94,
    lastSync: db ? `Live · ${new Date().toISOString()}` : "Live · refreshed 42s ago",
  }));
});

router.get("/staff", async (_req, res) => {
  const db = await loadStaff();
  res.json(ListStaffResponse.parse(db ?? staff));
});

router.post("/staff/sync-jira", async (req, res): Promise<void> => {
  try {
    const result = await syncJiraShifts();
    res.json(SyncStaffJiraResponse.parse(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isConfigurationError = message.startsWith(
      "Missing required environment variables:",
    );
    req.log.error(
      { err: error },
      isConfigurationError
        ? "Jira shift sync is not configured"
        : "Jira shift sync failed",
    );
    res.status(503).json({
      error: isConfigurationError
        ? "Jira shift sync is not configured on the server"
        : "Jira shift sync failed; check the integration logs",
      code: "JIRA_SYNC_UNAVAILABLE",
    });
  }
});

router.patch("/staff/:id", async (req, res) => {
  const params = UpdateStaffStatusParams.safeParse(req.params);
  const body = UpdateStaffStatusBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid staff status update" });
    return;
  }
  const list = (await loadStaff()) ?? staff;
  const member = list.find((item) => item.id === params.data.id);
  if (!member) {
    res.status(404).json({ error: "Staff member not found" });
    return;
  }
  await updateStaffStatus(params.data.id, body.data.status);
  member.status = body.data.status;
  member.updatedAt = "just now";
  member.isStale = false;
  res.json(UpdateStaffStatusResponse.parse(member));
});

router.get("/release-gates", (_req, res) => {
  res.json(ListReleaseGatesResponse.parse(releaseGates));
});

router.patch("/release-gates/:id/check", (req, res) => {
  const params = ToggleReleaseGateParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid release gate" });
    return;
  }
  const gate = releaseGates.find((item) => item.id === params.data.id);
  if (!gate) {
    res.status(404).json({ error: "Release gate not found" });
    return;
  }
  gate.checked = !gate.checked;
  res.json(ToggleReleaseGateResponse.parse(gate));
});

router.get("/procurement", async (_req, res) => {
  const db = await loadProcurement();
  res.json(ListProcurementRecordsResponse.parse(db ?? procurement));
});

router.patch("/procurement/:id/approve", async (req, res) => {
  const params = ApproveProcurementParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid procurement record" });
    return;
  }
  const list = (await loadProcurement()) ?? procurement;
  const record = list.find((item) => item.id === params.data.id);
  if (!record) {
    res.status(404).json({ error: "Procurement record not found" });
    return;
  }
  if (record.status.includes("Blocked")) {
    res.status(409).json({ error: "Resolve the financial variance before approval" });
    return;
  }
  await approveProcurement(params.data.id);
  record.status = "Payment Approved";
  res.json(ApproveProcurementResponse.parse(record));
});

router.get("/treasury", (_req, res) => {
  res.json(GetTreasuryAnalyticsResponse.parse({
    monthlyPayments: [
      { month: "Mar", paid: 12.8, committed: 14.4 }, { month: "Apr", paid: 15.2, committed: 16.1 },
      { month: "May", paid: 13.7, committed: 15.6 }, { month: "Jun", paid: 18.4, committed: 19.2 },
      { month: "Jul", paid: 16.9, committed: 18.8 }, { month: "Aug", paid: 14.6, committed: 20.4 },
    ],
    businessUnits: [
      { name: "Digital Banking", value: 24, color: "#0f766e" }, { name: "Corporate Systems", value: 18, color: "#2563eb" },
      { name: "Infrastructure", value: 16, color: "#84cc16" }, { name: "Cyber Security", value: 14, color: "#f59e0b" },
      { name: "Data & Analytics", value: 11, color: "#8b5cf6" }, { name: "Regional IT", value: 8, color: "#06b6d4" },
      { name: "End User Services", value: 5, color: "#f97316" }, { name: "Architecture", value: 4, color: "#ec4899" },
    ],
    fxRates: [
      { currency: "RMB/HKD", rate: 1.2, delta: 0 }, { currency: "MYR/HKD", rate: 1.8, delta: -0.4 },
      { currency: "IDR/HKD", rate: 0.000483, delta: 0.2 },
    ],
    totalYtd: 126800000,
    varianceRate: 1.7,
  }));
});

router.post("/compliance/search", async (req, res) => {
  const body = SearchComplianceBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Enter a compliance question" });
    return;
  }
  const result = await deepseek.search(body.data.query);
  res.json(SearchComplianceResponse.parse(result));
});

router.get("/audit-logs", (_req, res) => {
  res.json(ListAuditLogsResponse.parse(auditLogs));
});

// ---------------------------------------------------------------------
// Budget summary
// ---------------------------------------------------------------------
router.get("/budget/summary", async (req, res) => {
  const query = GetBudgetSummaryQueryParams.safeParse(req.query);
  const year = query.success && query.data.year != null ? Number(query.data.year) : undefined;
  try {
    const rows = await dbBreaker.run(async () => {
      const budgetRows = await loadBudgetSummary(year);
      if (!budgetRows) throw new Error("budget data unavailable");
      return budgetRows;
    });
    res.json(GetBudgetSummaryResponse.parse(rows.map((r) => ({
      fiscalYear: r.fiscalYear,
      category: r.category,
      allocated: r.allocated,
      incurred: r.incurred,
      paid: r.paid,
      remaining: r.remaining,
    }))));
  } catch (error) {
    if (error instanceof CircuitOpenError) {
      res.status(503).json({ error: "Budget service temporarily unavailable", code: "CIRCUIT_OPEN" });
      return;
    }
    res.json(GetBudgetSummaryResponse.parse([]));
  }
});

// ---------------------------------------------------------------------
// PR/PO workflow
// ---------------------------------------------------------------------
// POST /procurement — create a PR with budget pre-check
router.post("/procurement", async (req, res) => {
  const body = CreateProcurementRecordBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid procurement creation payload" });
    return;
  }
  const budget = await checkBudgetAvailability(body.data.budgetLineId, body.data.hkdAmount);
  if (!budget.ok) {
    res.status(409).json({ error: budget.reason ?? "Budget pre-check failed", code: "BUDGET" });
    return;
  }
  try {
    const record = await createProcurementRecord(body.data as unknown as Record<string, unknown>);
    if (!record) {
      res.status(500).json({ error: "Failed to create procurement record", code: "DB_ERROR" });
      return;
    }
    res.status(201).json(CreateProcurementRecordResponse.parse(record));
  } catch (error) {
    logger.error({ err: error }, "failed to create procurement record");
    res.status(500).json({ error: "Failed to create procurement record" });
  }
});

// PATCH /procurement/:id/status — advance tiered lifecycle
router.patch("/procurement/:id/status", async (req, res) => {
  const params = AdvanceProcurementStatusParams.safeParse(req.params);
  const body = AdvanceProcurementStatusBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid status transition payload" });
    return;
  }
  try {
    const result = await dbBreaker.run(() =>
      advanceProcurementStatus(params.data.id, body.data.toStatus, body.data.actorId),
    );
    if (!result.ok) {
      res.status(409).json({ error: result.error, code: result.code ?? "TRANSITION" });
      return;
    }
    res.json(AdvanceProcurementStatusResponse.parse(result.record));
  } catch (error) {
    if (error instanceof CircuitOpenError) {
      res.status(503).json({ error: error.message, code: "CIRCUIT_OPEN" });
      return;
    }
    logger.error({ err: error }, "failed to advance procurement status");
    res.status(500).json({ error: "Failed to advance procurement status" });
  }
});

// PATCH /procurement/:id/review — legal or security review decision
router.patch("/procurement/:id/review", async (req, res) => {
  const params = SubmitProcurementReviewParams.safeParse(req.params);
  const body = SubmitProcurementReviewBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid review payload" });
    return;
  }
  const result = await dbBreaker.run(() =>
    submitReview(params.data.id, body.data.reviewType, body.data.decision, body.data.reviewerId),
  );
  if (!result.ok) {
    if (result.code === "REVIEW_NOT_REQUIRED") {
      res.status(409).json({ error: result.error, code: result.code });
      return;
    }
    res.status(409).json({ error: result.error, code: result.code ?? "REVIEW" });
    return;
  }
  res.json(SubmitProcurementReviewResponse.parse(result.record));
});

// ---------------------------------------------------------------------
// Payment schedules + three-way match
// ---------------------------------------------------------------------
router.get("/procurement/:id/payments", async (req, res) => {
  const params = ListPaymentSchedulesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid payment list payload" });
    return;
  }
  const rows = await listPaymentSchedules(params.data.id);
  res.json(ListPaymentSchedulesResponse.parse(rows ?? []));
});

router.post("/procurement/:id/payments", async (req, res) => {
  const params = CreatePaymentScheduleParams.safeParse(req.params);
  const body = CreatePaymentScheduleBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid payment schedule payload" });
    return;
  }
  const record = await getProcurementById(params.data.id);
  if (!record) {
    res.status(404).json({ error: "Procurement record not found", code: "NOT_FOUND" });
    return;
  }
  try {
    const schedule = await createPaymentSchedule(params.data.id, body.data as unknown as Record<string, unknown>);
    if (!schedule) {
      res.status(409).json({ error: "Milestones would exceed PO amount", code: "MILESTONE_OVERFLOW" });
      return;
    }
    res.status(201).json(CreatePaymentScheduleResponse.parse(schedule));
  } catch {
    res.status(409).json({ error: "Milestones would exceed PO amount", code: "MILESTONE_OVERFLOW" });
  }
});

// PATCH /payments/:id/invoice — submit invoice / OCR, triggers 3-way match
router.patch("/payments/:id/invoice", async (req, res) => {
  const params = SubmitInvoiceParams.safeParse(req.params);
  const body = SubmitInvoiceBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid invoice payload" });
    return;
  }
  try {
    const schedule = await withRetry(
      () => submitInvoice(params.data.id, body.data as unknown as Record<string, unknown>),
      { maxAttempts: 3, baseDelayMs: 1000 },
    );
    if (!schedule) {
      res.status(404).json({ error: "Payment schedule not found", code: "NOT_FOUND" });
      return;
    }
    res.json(SubmitInvoiceResponse.parse(schedule));
  } catch {
    res.status(500).json({ error: "Failed to submit invoice" });
  }
});

// GET /payments/:id/three-way — three-way match result
router.get("/payments/:id/three-way", async (req, res) => {
  const params = GetThreeWayMatchParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid three-way match payload" });
    return;
  }
  const match = await getThreeWayMatch(params.data.id);
  if (!match) {
    res.status(404).json({ error: "No three-way match found", code: "NOT_FOUND" });
    return;
  }
  res.json(GetThreeWayMatchResponse.parse(match));
});

// PATCH /payments/:id/variance — resolve blocked variance
router.patch("/payments/:id/variance", async (req, res) => {
  const params = ResolveVarianceParams.safeParse(req.params);
  const body = ResolveVarianceBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid variance resolution payload" });
    return;
  }
  const result = await dbBreaker.run(() =>
    resolveVariance(params.data.id, body.data.resolvedBy, body.data.resolutionNotes),
  );
  if (!result.ok) {
    res.status(409).json({ error: result.error, code: result.code ?? "VARIANCE" });
    return;
  }
  res.json(ResolveVarianceResponse.parse(result.schedule));
});

// PATCH /payments/:id/signoff — dual sign-off (< 250k skip)
router.patch("/payments/:id/signoff", async (req, res) => {
  const params = DualSignoffParams.safeParse(req.params);
  const body = DualSignoffBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid sign-off payload" });
    return;
  }
  const result = await dbBreaker.run(() =>
    dualSignoff(params.data.id, body.data.headId, body.data.financeId),
  );
  if (!result.ok) {
    res.status(409).json({ error: result.error, code: result.code ?? "SIGNOFF" });
    return;
  }
  res.json(DualSignoffResponse.parse(result.schedule));
});

// PATCH /payments/:id/pay — mark paid
router.patch("/payments/:id/pay", async (req, res) => {
  const params = MarkPaidParams.safeParse(req.params);
  const body = MarkPaidBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid payment payload" });
    return;
  }
  const result = await dbBreaker.run(() =>
    markPaid(params.data.id, body.data.paidAmount, body.data.paymentReference),
  );
  if (!result.ok) {
    res.status(409).json({ error: result.error, code: result.code ?? "PAYMENT" });
    return;
  }
  res.json(MarkPaidResponse.parse(result.schedule));
});

// ---------------------------------------------------------------------
// DLQ management
// ---------------------------------------------------------------------
router.get("/dlq", async (req, res) => {
  const query = ListDlqEntriesQueryParams.safeParse(req.query);
  const status = query.success && query.data.status ? String(query.data.status) : undefined;
  const rows = await listDlq(status);
  res.json(ListDlqEntriesResponse.parse(rows ?? []));
});

router.patch("/dlq/:id/reprocess", async (req, res) => {
  const params = ReprocessDlqEntryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid DLQ payload" });
    return;
  }
  const ok = await reprocessDlq(params.data.id);
  if (!ok) {
    res.status(409).json({ error: "Entry cannot be reprocessed", code: "DLQ" });
    return;
  }
  const entry = (await listDlq())?.find((e) => e.id === params.data.id);
  res.json(ReprocessDlqEntryResponse.parse(entry ?? { id: params.data.id, status: "PENDING", retryCount: 0, maxRetries: 5 }));
});

router.patch("/dlq/:id/discard", async (req, res) => {
  const params = DiscardDlqEntryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid DLQ payload" });
    return;
  }
  const ok = await discardDlq(params.data.id);
  if (!ok) {
    res.status(409).json({ error: "Entry cannot be discarded", code: "DLQ" });
    return;
  }
  const entry = (await listDlq())?.find((e) => e.id === params.data.id);
  res.json(DiscardDlqEntryResponse.parse(entry ?? { id: params.data.id, status: "DISCARDED", retryCount: 0, maxRetries: 5 }));
});

export default router;