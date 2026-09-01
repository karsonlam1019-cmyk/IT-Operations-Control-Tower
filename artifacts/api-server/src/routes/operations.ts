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
  ConfirmVendorPortalMilestoneBody,
  ConfirmVendorPortalMilestoneHeader,
  ConfirmVendorPortalMilestoneParams,
  ConfirmVendorPortalMilestoneResponse,
  DiscardDlqEntryParams,
  DiscardDlqEntryResponse,
  DualSignoffBody,
  DualSignoffParams,
  DualSignoffResponse,
  GetBudgetSummaryQueryParams,
  GetBudgetSummaryResponse,
  GetDelegationStatusResponse,
  GetDashboardSummaryResponse,
  GetThreeWayMatchParams,
  GetThreeWayMatchResponse,
  GetTreasuryAnalyticsResponse,
  GetVendorPortalSessionHeader,
  GetVendorPortalSessionResponse,
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
  SubmitVendorPortalInvoiceBody,
  SubmitVendorPortalInvoiceHeader,
  SubmitVendorPortalInvoiceParams,
  SubmitVendorPortalInvoiceResponse,
  ToggleReleaseGateParams,
  ToggleReleaseGateResponse,
  UpdateStaffStatusBody,
  UpdateStaffStatusParams,
  UpdateStaffStatusResponse,
  UpdateHeadOfItLeaveBody,
  UpdateHeadOfItLeaveResponse,
} from "@workspace/api-zod";
import { deepseek } from "../integrations/deepseek";
import {
  approveProcurement,
  advanceProcurementStatus,
  checkBudgetAvailability,
  confirmVendorMilestone,
  createPaymentSchedule,
  createProcurementRecord,
  discardDlq,
  dualSignoff,
  getPaymentSchedule,
  getProcurementById,
  getThreeWayMatch,
  loadAuditLogs,
  loadDelegationStatus,
  listDlq,
  listPaymentSchedules,
  loadBudgetSummary,
  loadDashboardStats,
  loadProcurement,
  loadStaff,
  loadVendorPortalPurchaseOrders,
  markPaid,
  reprocessDlq,
  resolveVariance,
  submitInvoice,
  submitVendorInvoice,
  submitReview,
  updateStaffStatus,
  updateHeadOfItLeave,
  recordAuditEvent,
} from "../lib/db-runtime";
import { resolveVendorPortalIdentity, type VendorPortalIdentity } from "../integrations/vendor";
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

const demoVendorPortalOrders = [
  {
    ...procurement[0],
    status: "Purchase Order Issued",
    projectCode: "PROJ-CLOUD-2026-042",
    paymentTerms: "Milestone 3:7",
    expectedSettlementMonth: "2026-10",
    milestones: [
      {
        id: "m-demo-001",
        procurementId: procurement[0].id,
        dueDate: "2026-08-28",
        amount: 128400,
        isMilestonePayment: true,
        milestoneNumber: 1,
        milestoneDescription: "Cloud tenancy and security baseline",
        invoiceAmount: 128400,
        invoiceNumber: "INV-NCS-26081",
        isVarianceDetected: false,
        varianceType: "",
        varianceAmount: 0,
        varianceResolutionNotes: "",
        dualSignoffAt: "",
        paidAt: "2026-08-29",
        paidAmount: 128400,
        paymentReference: "PAY-2026-0841",
        threeWayMatch: "MATCHED",
        confirmationStatus: "CONFIRMED",
        confirmationNote: "Baseline controls delivered and accepted.",
        confirmedAt: "2026-08-28T09:20:00.000Z",
      },
      {
        id: "m-demo-002",
        procurementId: procurement[0].id,
        dueDate: "2026-10-15",
        amount: 299600,
        isMilestonePayment: true,
        milestoneNumber: 2,
        milestoneDescription: "Production migration and service handover",
        invoiceAmount: 0,
        invoiceNumber: "",
        isVarianceDetected: false,
        varianceType: "",
        varianceAmount: 0,
        varianceResolutionNotes: "",
        dualSignoffAt: "",
        paidAt: "",
        paidAmount: 0,
        paymentReference: "",
        threeWayMatch: "PENDING",
        confirmationStatus: "PENDING",
        confirmationNote: "",
        confirmedAt: "",
      },
    ],
  },
];

async function findVendorPortalOrder(identity: VendorPortalIdentity, purchaseOrderId: string) {
  if (identity.demoMode) {
    return demoVendorPortalOrders.find((item) => item.id === purchaseOrderId) ?? null;
  }
  const orders = await loadVendorPortalPurchaseOrders(identity.id);
  return orders?.find((item) => item.id === purchaseOrderId) ?? null;
}

async function findVendorPortalMilestone(identity: VendorPortalIdentity, milestoneId: string) {
  const orders = identity.demoMode
    ? demoVendorPortalOrders
    : (await loadVendorPortalPurchaseOrders(identity.id)) ?? [];
  for (const order of orders) {
    const milestone = order.milestones.find((item) => item.id === milestoneId);
    if (milestone) return { order, milestone };
  }
  return null;
}

let auditLogs = [
  { id: "a-01", actor: "Darren Tam", action: "Approved L2 purchase order", target: "PO-2026-0611", timestamp: "2026-08-28T10:42:18+08:00", region: "HK", actedAsDeputy: false },
  { id: "a-02", actor: "Marcus Wong", action: "Activated delegated authority", target: "Head of IT role", timestamp: "2026-08-28T09:58:04+08:00", region: "HK", actedAsDeputy: true },
  { id: "a-03", actor: "Maya Chen", action: "Updated incident status", target: "INC-4821", timestamp: "2026-08-28T09:44:51+08:00", region: "HK", actedAsDeputy: false },
  { id: "a-04", actor: "Finance Control", action: "Blocked payment variance", target: "PO-2026-0607", timestamp: "2026-08-27T16:19:37+08:00", region: "CN", actedAsDeputy: false },
  { id: "a-05", actor: "Ethan Wong", action: "Completed release gate", target: "UAT data reconciliation", timestamp: "2026-08-27T15:52:13+08:00", region: "HK", actedAsDeputy: false },
];

let demoHeadOnLeave = false;
const demoDelegationStatus = () => ({
  headOfIt: { id: "s-head-it", name: "Leah Chan", role: "SUPER_ADMIN", region: "HK", onLeave: demoHeadOnLeave },
  deputy: { id: "s-deputy-it", name: "Marcus Wong", role: "DEPUTY_HEAD_OF_IT", region: "HK", onLeave: false },
  delegationActive: demoHeadOnLeave,
  authorityLabel: demoHeadOnLeave ? "Deputy authority · Marcus Wong" : "Head of IT · Leah Chan",
});

const demoActors: Record<string, { name: string; region: string; isDeputy?: boolean }> = {
  "s-head-it": { name: "Leah Chan", region: "HK" },
  "7937447c-090e-4248-885b-0798763e5994": { name: "Leah Chan", region: "HK" },
  "s-deputy-it": { name: "Marcus Wong", region: "HK", isDeputy: true },
  "11b50e41-88e6-4297-bdba-6c76caf641ec": { name: "Marcus Wong", region: "HK", isDeputy: true },
  "57198c98-3a7b-4e16-b072-5c4c9dd31ffe": { name: "Priya Nair", region: "MY" },
  "0ebb310c-b241-48b0-9254-7b78f7634676": { name: "Siti Halim", region: "HK" },
};

async function writeOperationalAudit(action: string, target: string, actorId?: string) {
  const persisted = await recordAuditEvent(action, target, actorId);
  if (persisted) {
    return;
  }
  const status = demoDelegationStatus();
  const effectiveActorId = actorId ?? (status.delegationActive ? status.deputy.id : status.headOfIt.id);
  const knownActor = demoActors[effectiveActorId];
  const actor = knownActor ?? { name: "Authorized operator", region: "HK" };
  const actedAsDeputy = status.delegationActive && Boolean(knownActor?.isDeputy);
  auditLogs.unshift({
    id: `a-demo-${Date.now()}-${auditLogs.length}`,
    actor: actor.name,
    action,
    target,
    timestamp: new Date().toISOString(),
    region: actor.region,
    actedAsDeputy,
  });
}

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
  await writeOperationalAudit("Updated staff status", `staff:${member.id}`);
  res.json(UpdateStaffStatusResponse.parse(member));
});

router.get("/governance/delegation", async (_req, res) => {
  const status = (await loadDelegationStatus()) ?? demoDelegationStatus();
  res.json(GetDelegationStatusResponse.parse(status));
});

router.patch("/governance/delegation/leave", async (req, res) => {
  const body = UpdateHeadOfItLeaveBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid Head of IT leave update" });
    return;
  }

  const persisted = await updateHeadOfItLeave(body.data.onLeave);
  if (persisted) {
    res.json(UpdateHeadOfItLeaveResponse.parse(persisted));
    return;
  }

  if (demoHeadOnLeave !== body.data.onLeave) {
    demoHeadOnLeave = body.data.onLeave;
    auditLogs.unshift({
      id: `a-demo-leave-${Date.now()}`,
      actor: "Leah Chan",
      action: body.data.onLeave ? "Marked Head of IT on leave" : "Marked Head of IT available",
      target: "Head of IT role",
      timestamp: new Date().toISOString(),
      region: "HK",
      actedAsDeputy: false,
    });
    if (body.data.onLeave) {
      auditLogs.unshift({
        id: `a-demo-delegation-${Date.now()}`,
        actor: "Marcus Wong",
        action: "Activated delegated authority",
        target: "Head of IT role",
        timestamp: new Date().toISOString(),
        region: "HK",
        actedAsDeputy: true,
      });
    }
  }
  res.json(UpdateHeadOfItLeaveResponse.parse(demoDelegationStatus()));
});

router.get("/release-gates", (_req, res) => {
  res.json(ListReleaseGatesResponse.parse(releaseGates));
});

router.patch("/release-gates/:id/check", async (req, res) => {
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
  await writeOperationalAudit(
    gate.checked ? "Completed release gate" : "Reopened release gate",
    `release-gate:${gate.id}`,
  );
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
  await writeOperationalAudit("Approved procurement record", record.poNumber || record.prNumber);
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

router.get("/audit-logs", async (_req, res) => {
  const db = await loadAuditLogs();
  res.json(ListAuditLogsResponse.parse(db ?? auditLogs));
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
    await writeOperationalAudit(
      `Advanced procurement to ${body.data.toStatus}`,
      `procurement:${params.data.id}`,
      body.data.actorId,
    );
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
  await writeOperationalAudit(
    `${body.data.reviewType} review ${body.data.decision.toLowerCase()}`,
    `procurement:${params.data.id}`,
    body.data.reviewerId,
  );
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
// External vendor portal
// ---------------------------------------------------------------------
router.get("/vendor/portal/session", async (req, res): Promise<void> => {
  const header = GetVendorPortalSessionHeader.safeParse({
    "X-Vendor-API-Key": req.header("X-Vendor-API-Key") ?? "",
  });
  const identity = header.success
    ? resolveVendorPortalIdentity(header.data["X-Vendor-API-Key"])
    : null;
  if (!identity) {
    res.status(401).json({ error: "The vendor API key is invalid", code: "INVALID_VENDOR_KEY" });
    return;
  }

  let purchaseOrders;
  try {
    purchaseOrders = identity.demoMode
      ? demoVendorPortalOrders
      : await loadVendorPortalPurchaseOrders(identity.id);
  } catch (error) {
    logger.error({ err: error, vendorId: identity.id }, "Vendor portal session query failed");
    res.status(503).json({
      error: "The vendor workspace is temporarily unavailable",
      code: "VENDOR_PORTAL_UNAVAILABLE",
    });
    return;
  }
  if (!purchaseOrders) {
    res.status(503).json({
      error: "The vendor workspace is temporarily unavailable",
      code: "VENDOR_PORTAL_UNAVAILABLE",
    });
    return;
  }
  res.json(GetVendorPortalSessionResponse.parse({
    vendor: {
      id: identity.id,
      name: identity.name,
      region: identity.region,
      contact: identity.contact,
    },
    purchaseOrders,
    demoMode: identity.demoMode,
  }));
});

router.post("/vendor/portal/purchase-orders/:id/invoices", async (req, res): Promise<void> => {
  const params = SubmitVendorPortalInvoiceParams.safeParse(req.params);
  const header = SubmitVendorPortalInvoiceHeader.safeParse({
    "X-Vendor-API-Key": req.header("X-Vendor-API-Key") ?? "",
  });
  const body = SubmitVendorPortalInvoiceBody.safeParse(req.body);
  const identity = header.success
    ? resolveVendorPortalIdentity(header.data["X-Vendor-API-Key"])
    : null;
  if (!identity) {
    res.status(401).json({ error: "The vendor API key is invalid", code: "INVALID_VENDOR_KEY" });
    return;
  }
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Enter a valid invoice number, date, and amount", code: "INVALID_INVOICE" });
    return;
  }

  let order;
  try {
    order = await findVendorPortalOrder(identity, params.data.id);
  } catch (error) {
    logger.error({ err: error, vendorId: identity.id }, "Vendor portal invoice lookup failed");
    res.status(503).json({
      error: "The vendor workspace is temporarily unavailable",
      code: "VENDOR_PORTAL_UNAVAILABLE",
    });
    return;
  }
  if (!order) {
    res.status(403).json({ error: "This purchase order is outside your vendor account", code: "VENDOR_SCOPE" });
    return;
  }
  const milestone = order.milestones.find((item) => item.id === body.data.paymentScheduleId);
  if (!milestone) {
    res.status(403).json({ error: "This payment milestone is outside your vendor account", code: "VENDOR_SCOPE" });
    return;
  }
  if (milestone.paidAt || milestone.invoiceNumber) {
    res.status(409).json({ error: "An invoice has already been submitted for this milestone", code: "INVOICE_EXISTS" });
    return;
  }

  if (identity.demoMode) {
    milestone.invoiceAmount = body.data.invoiceAmount;
    milestone.invoiceNumber = body.data.invoiceNumber;
    milestone.isVarianceDetected = body.data.invoiceAmount !== milestone.amount;
    milestone.varianceType = milestone.isVarianceDetected ? "PRICE" : "";
    milestone.varianceAmount = milestone.isVarianceDetected
      ? Math.abs(body.data.invoiceAmount - milestone.amount)
      : 0;
    milestone.threeWayMatch = milestone.isVarianceDetected ? "PRICE_VARIANCE" : "MATCHED";
    res.json(SubmitVendorPortalInvoiceResponse.parse(milestone));
    return;
  }

  const updated = await submitVendorInvoice(
    milestone.id,
    order.id,
    body.data as unknown as Record<string, unknown>,
  );
  if (!updated) {
    res.status(409).json({ error: "This invoice could not be submitted", code: "INVOICE_REJECTED" });
    return;
  }
  res.json(SubmitVendorPortalInvoiceResponse.parse(updated));
});

router.patch("/vendor/portal/milestones/:id/confirm", async (req, res): Promise<void> => {
  const params = ConfirmVendorPortalMilestoneParams.safeParse(req.params);
  const header = ConfirmVendorPortalMilestoneHeader.safeParse({
    "X-Vendor-API-Key": req.header("X-Vendor-API-Key") ?? "",
  });
  const body = ConfirmVendorPortalMilestoneBody.safeParse(req.body ?? {});
  const identity = header.success
    ? resolveVendorPortalIdentity(header.data["X-Vendor-API-Key"])
    : null;
  if (!identity) {
    res.status(401).json({ error: "The vendor API key is invalid", code: "INVALID_VENDOR_KEY" });
    return;
  }
  if (!params.success || !body.success) {
    res.status(400).json({ error: "The milestone confirmation is invalid", code: "INVALID_MILESTONE" });
    return;
  }

  let scoped;
  try {
    scoped = await findVendorPortalMilestone(identity, params.data.id);
  } catch (error) {
    logger.error({ err: error, vendorId: identity.id }, "Vendor portal milestone lookup failed");
    res.status(503).json({
      error: "The vendor workspace is temporarily unavailable",
      code: "VENDOR_PORTAL_UNAVAILABLE",
    });
    return;
  }
  if (!scoped) {
    res.status(403).json({ error: "This milestone is outside your vendor account", code: "VENDOR_SCOPE" });
    return;
  }
  if (!scoped.milestone.isMilestonePayment || scoped.milestone.confirmationStatus === "CONFIRMED") {
    res.status(409).json({ error: "This milestone cannot be confirmed", code: "MILESTONE_NOT_PENDING" });
    return;
  }

  if (identity.demoMode) {
    scoped.milestone.confirmationStatus = "CONFIRMED";
    scoped.milestone.confirmationNote = body.data.confirmationNote ?? "";
    scoped.milestone.confirmedAt = new Date().toISOString();
    res.json(ConfirmVendorPortalMilestoneResponse.parse(scoped.milestone));
    return;
  }

  const updated = await confirmVendorMilestone(
    scoped.milestone.id,
    body.data.confirmationNote,
  );
  if (!updated) {
    res.status(409).json({ error: "This milestone could not be confirmed", code: "MILESTONE_REJECTED" });
    return;
  }
  res.json(ConfirmVendorPortalMilestoneResponse.parse(updated));
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