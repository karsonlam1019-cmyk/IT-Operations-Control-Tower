import { readEnv } from "../integrations/config";
import { registerDlqCapture } from "./resilience";

// Runtime PostgreSQL data access for the live Supabase database.
//
// The pool is loaded lazily (dynamic import) so the server never crashes at
// startup when DATABASE_URL is missing (e.g. a deployment without a DB).
// Every query is guarded and falls back to `null` so callers can degrade to
// representative data instead of breaking the endpoint.

type DbPool = {
  query: (
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
};

let poolPromise: Promise<DbPool | null> | null = null;

function isDbConfigured(): boolean {
  return Boolean(readEnv("DATABASE_URL"));
}

async function getPool(): Promise<DbPool | null> {
  if (!isDbConfigured()) return null;
  if (!poolPromise) {
    poolPromise = import("@workspace/db")
      .then((mod) => (mod.pool ?? null) as DbPool | null)
      .catch(() => null);
  }
  return poolPromise;
}

const str = (v: unknown): string => (v == null ? "" : String(v));
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// ---------------------------------------------------------------------
// Staff (profiles + teams + staff_statuses)
// ---------------------------------------------------------------------
export type RuntimeStaffMember = {
  id: string;
  name: string;
  initials: string;
  role: string;
  team: string;
  region: string;
  status: string;
  ticket: string;
  environment: string;
  eta: string;
  updatedAt: string;
  isStale: boolean;
};

export async function loadStaff(): Promise<RuntimeStaffMember[] | null> {
  const pool = await getPool();
  if (!pool) return null;
  try {
    const { rows } = await pool.query(
      `SELECT
         p.id::text AS id,
         p.full_name AS name,
         p.role AS role,
         COALESCE(t.team_name, 'Unassigned') AS team,
         p.region AS region,
         COALESCE(ss.status_text, 'Active') AS status,
         COALESCE(ss.active_ticket_id, 'N/A') AS ticket,
         COALESCE(ss.environment, 'SIT') AS environment,
         COALESCE(to_char(ss.eta_completion, 'HH24:MI'), 'N/A') AS eta,
         COALESCE(to_char(ss.updated_at, 'HH24:MI'), to_char(p.created_at, 'HH24:MI')) AS updated,
         COALESCE(ss.is_stale, false) AS is_stale
       FROM profiles p
       LEFT JOIN teams t ON t.id = p.team_id
       LEFT JOIN staff_statuses ss ON ss.user_id = p.id
       ORDER BY p.full_name`,
    );
    return rows.map((row) => {
      const name = str(row.name);
      const parts = name.trim().split(/\s+/).filter(Boolean);
      const initials =
        (parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[1]?.[0] ?? "") : "");
      return {
        id: str(row.id),
        name,
        initials: initials.toUpperCase(),
        role: str(row.role),
        team: str(row.team),
        region: str(row.region),
        status: str(row.status),
        ticket: str(row.ticket),
        environment: str(row.environment),
        eta: str(row.eta),
        updatedAt: str(row.updated).length ? `${str(row.updated)} today` : "—",
        isStale: Boolean(row.is_stale),
      };
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Governance (Head of IT leave + automatic deputy authority)
// ---------------------------------------------------------------------
export type RuntimeGovernancePerson = {
  id: string;
  name: string;
  role: string;
  region: string;
  onLeave: boolean;
};

export type RuntimeDelegationStatus = {
  headOfIt: RuntimeGovernancePerson;
  deputy: RuntimeGovernancePerson | null;
  delegationActive: boolean;
  authorityLabel: string;
};

export type RuntimeAuditLog = {
  id: string;
  actor: string;
  action: string;
  target: string;
  timestamp: string;
  region: string;
  actedAsDeputy: boolean;
};

export async function loadDelegationStatus(): Promise<RuntimeDelegationStatus | null> {
  const pool = await getPool();
  if (!pool) return null;
  try {
    const { rows } = await pool.query(
      `SELECT
         head.id::text AS head_id,
         head.full_name AS head_name,
         head.role AS head_role,
         head.region AS head_region,
         COALESCE(head.on_leave, false) AS head_on_leave,
         deputy.id::text AS deputy_id,
         deputy.full_name AS deputy_name,
         deputy.role AS deputy_role,
         deputy.region AS deputy_region,
         COALESCE(deputy.on_leave, false) AS deputy_on_leave
       FROM profiles head
       LEFT JOIN profiles deputy
         ON deputy.deputy_for_user_id = head.id
        AND deputy.role = 'DEPUTY_HEAD_OF_IT'
        AND COALESCE(deputy.on_leave, false) = false
       WHERE head.role = 'SUPER_ADMIN'
       ORDER BY head.created_at
       LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return null;
    const delegationActive = Boolean(row.head_on_leave) && Boolean(row.deputy_id);
    return {
      headOfIt: {
        id: str(row.head_id),
        name: str(row.head_name),
        role: str(row.head_role),
        region: str(row.head_region),
        onLeave: Boolean(row.head_on_leave),
      },
      deputy: row.deputy_id ? {
        id: str(row.deputy_id),
        name: str(row.deputy_name),
        role: str(row.deputy_role),
        region: str(row.deputy_region),
        onLeave: Boolean(row.deputy_on_leave),
      } : null,
      delegationActive,
      authorityLabel: delegationActive
        ? `Deputy authority · ${str(row.deputy_name)}`
        : `Head of IT · ${str(row.head_name)}`,
    };
  } catch {
    return null;
  }
}

export async function updateHeadOfItLeave(
  onLeave: boolean,
): Promise<RuntimeDelegationStatus | null> {
  const pool = await getPool();
  if (!pool) return null;
  try {
    const result = await pool.query(
      `UPDATE profiles
          SET on_leave = $1
        WHERE id = (
          SELECT id
            FROM profiles
           WHERE role = 'SUPER_ADMIN'
           ORDER BY created_at
           LIMIT 1
        )
        RETURNING id::text AS id, full_name AS name`,
      [onLeave],
    );
    const head = result.rows[0];
    if (!head) return null;
    await pool.query(
      `INSERT INTO audit_logs (
         actor_id, action_type, target_resource, old_value, new_value, acted_as_deputy
       ) VALUES (
         $1::uuid, $2, $3, $4::jsonb, $5::jsonb, FALSE
       )`,
      [
        str(head.id),
        onLeave ? "HEAD_OF_IT_LEAVE_ENABLED" : "HEAD_OF_IT_LEAVE_DISABLED",
        `profile:${str(head.id)}`,
        JSON.stringify({ onLeave: !onLeave }),
        JSON.stringify({ onLeave }),
      ],
    );
    return loadDelegationStatus();
  } catch {
    return null;
  }
}

export async function recordAuditEvent(
  action: string,
  target: string,
  actorId?: string,
): Promise<RuntimeAuditLog | null> {
  const pool = await getPool();
  if (!pool) return null;
  try {
    const status = await loadDelegationStatus();
    if (!status) return null;
    const effectiveActorId = actorId || (status.delegationActive ? status.deputy?.id : status.headOfIt.id);
    if (!effectiveActorId) return null;
    const actedAsDeputy = Boolean(
      status.delegationActive
      && status.deputy
      && effectiveActorId === status.deputy.id,
    );
    const { rows } = await pool.query(
      `INSERT INTO audit_logs (
         actor_id, action_type, target_resource, acted_as_deputy
       ) VALUES ($1::uuid, $2, $3, $4)
       RETURNING id::text AS id, created_at`,
      [effectiveActorId, action, target, actedAsDeputy],
    );
    const row = rows[0];
    if (!row) return null;
    const actorResult = await pool.query(
      `SELECT full_name AS name, region
         FROM profiles
        WHERE id = $1::uuid
        LIMIT 1`,
      [effectiveActorId],
    );
    const actorRow = actorResult.rows[0];
    return {
      id: str(row.id),
      actor: actorRow?.name ? str(actorRow.name) : "System",
      action,
      target,
      timestamp: str(row.created_at),
      region: actorRow?.region ? str(actorRow.region) : "HK",
      actedAsDeputy,
    };
  } catch {
    return null;
  }
}

export async function loadAuditLogs(): Promise<RuntimeAuditLog[] | null> {
  const pool = await getPool();
  if (!pool) return null;
  try {
    const { rows } = await pool.query(
      `SELECT
         a.id::text AS id,
         COALESCE(p.full_name, 'System') AS actor,
         a.action_type AS action,
         a.target_resource AS target,
         to_char(a.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS timestamp,
         COALESCE(p.region, 'HK') AS region,
         COALESCE(a.acted_as_deputy, false) AS acted_as_deputy
       FROM audit_logs a
       LEFT JOIN profiles p ON p.id = a.actor_id
       ORDER BY a.created_at DESC`,
    );
    return rows.map((row) => ({
      id: str(row.id),
      actor: str(row.actor),
      action: str(row.action),
      target: str(row.target),
      timestamp: str(row.timestamp),
      region: str(row.region),
      actedAsDeputy: Boolean(row.acted_as_deputy),
    }));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Procurement (procurement_records + vendors)
// ---------------------------------------------------------------------
const STATUS_LABEL: Record<string, string> = {
  PR_DRAFT: "Pending L1 Approval",
  PR_APPROVED: "Pending L2 Approval",
  PO_ISSUED: "Pending L3 Approval",
  MILESTONE_RECEIVED: "Milestone Received",
  INVOICE_PENDING: "Payment Pending",
  VARIANCE_BLOCKED: "Variance Blocked",
  PAYMENT_APPROVED: "Payment Approved",
  PAID: "Paid",
};

function isPendingStatus(label: string): boolean {
  return label.includes("Pending");
}

export type RuntimeProcurementRecord = {
  id: string;
  prNumber: string;
  poNumber: string;
  vendor: string;
  region: string;
  amount: number;
  currency: string;
  hkdAmount: number;
  status: string;
  match: string;
  createdAt: string;
};

export async function loadProcurement(): Promise<RuntimeProcurementRecord[] | null> {
  const pool = await getPool();
  if (!pool) return null;
  try {
    const { rows } = await pool.query(
      `SELECT
         pr.id::text AS id,
         pr.pr_number AS pr_number,
         COALESCE(pr.po_number, '') AS po_number,
         v.vendor_name AS vendor,
         pr.region AS region,
         pr.local_amount::float8 AS amount,
         pr.local_currency AS currency,
         pr.hkd_amount::float8 AS hkd_amount,
         pr.status AS status,
         to_char(pr.created_at, 'DD Mon YYYY, HH24:MI') AS created_at
       FROM procurement_records pr
       LEFT JOIN vendors v ON v.id = pr.vendor_id
       ORDER BY pr.created_at DESC`,
    );
    return rows.map((row) => {
      const statusKey = str(row.status) || "PR_DRAFT";
      const label = STATUS_LABEL[statusKey] ?? statusKey;
      return {
        id: str(row.id),
        prNumber: str(row.pr_number),
        poNumber: str(row.po_number),
        vendor: str(row.vendor),
        region: str(row.region),
        amount: num(row.amount),
        currency: str(row.currency),
        hkdAmount: num(row.hkd_amount),
        status: label,
        match: statusKey === "VARIANCE_BLOCKED" ? "Variance" : "Matched",
        createdAt: str(row.created_at),
      };
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Dashboard summary
// ---------------------------------------------------------------------
export type RuntimeDashboardSummary = {
  activeStaff: number;
  staleStaff: number;
  pendingApprovals: number;
  blockedVariances: number;
};

export async function loadDashboardStats(): Promise<RuntimeDashboardSummary | null> {
  const pool = await getPool();
  if (!pool) return null;
  try {
    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM profiles) AS active_staff,
         (SELECT count(*)::int FROM staff_statuses WHERE is_stale) AS stale_staff,
         (SELECT count(*)::int FROM procurement_records
           WHERE status IN ('PR_DRAFT','PR_APPROVED','PO_ISSUED','MILESTONE_RECEIVED','INVOICE_PENDING')) AS pending_approvals,
         (SELECT count(*)::int FROM procurement_records WHERE status = 'VARIANCE_BLOCKED') AS blocked_variances`,
    );
    const row = rows[0] ?? {};
    return {
      activeStaff: num(row.active_staff),
      staleStaff: num(row.stale_staff),
      pendingApprovals: num(row.pending_approvals),
      blockedVariances: num(row.blocked_variances),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Mutations (best-effort; fall back through callers)
// ---------------------------------------------------------------------
export async function updateStaffStatus(
  userId: string,
  statusText: string,
): Promise<boolean> {
  const pool = await getPool();
  if (!pool) return false;
  try {
    await pool.query(
      `INSERT INTO staff_statuses (user_id, status_text, updated_at)
       VALUES ($1::uuid, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET status_text = EXCLUDED.status_text, is_stale = false, updated_at = NOW()`,
      [userId, statusText],
    );
    return true;
  } catch {
    return false;
  }
}

export async function approveProcurement(id: string): Promise<boolean> {
  const pool = await getPool();
  if (!pool) return false;
  try {
    await pool.query(
      `UPDATE procurement_records SET status = 'PAYMENT_APPROVED' WHERE id = $1::uuid`,
      [id],
    );
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------
// DLQ (Dead Letter Queue) — DB-backed capture + lifecycle
// ---------------------------------------------------------------------
export type RuntimeDlqEntry = {
  id: string;
  status: string;
  errorCode: string;
  errorMessage: string;
  retryCount: number;
  maxRetries: number;
  createdAt: string;
  updatedAt: string;
};

const mapDlq = (row: Record<string, unknown>): RuntimeDlqEntry => ({
  id: str(row.id),
  status: str(row.status),
  errorCode: str(row.error_code),
  errorMessage: str(row.error_message),
  retryCount: num(row.retry_count),
  maxRetries: num(row.max_retries),
  createdAt: str(row.created_at),
  updatedAt: str(row.updated_at),
});

function registerDbDlqCapture(): void {
  registerDlqCapture(async (payload, error) => {
    const pool = await getPool();
    if (!pool) return;
    await pool.query(
      `INSERT INTO dlq_entries (status, payload, error_code, error_message, retry_count, max_retries, next_attempt_at)
       VALUES ('PENDING', $1::jsonb, $2, $3, 0, 5, NOW() + INTERVAL '1 minute')`,
      [JSON.stringify(payload), error.code ?? null, error.message ?? null],
    );
  });
}
registerDbDlqCapture();

export async function listDlq(
  status?: string,
): Promise<RuntimeDlqEntry[] | null> {
  const pool = await getPool();
  if (!pool) return null;
  try {
    const { rows } = await pool.query(
      `SELECT id::text AS id, status, error_code, error_message,
              retry_count, max_retries, created_at, updated_at
         FROM dlq_entries
        WHERE ($1::text IS NULL OR status = $1::text)
        ORDER BY created_at DESC`,
      [status ?? null],
    );
    return rows.map(mapDlq);
  } catch {
    return null;
  }
}

export async function reprocessDlq(id: string): Promise<boolean> {
  const pool = await getPool();
  if (!pool) return false;
  try {
    await pool.query(
      `UPDATE dlq_entries
          SET status = 'PENDING', retry_count = retry_count + 1, next_attempt_at = NOW(),
              updated_at = NOW()
        WHERE id = $1::uuid AND status IN ('PENDING','FAILED')`,
      [id],
    );
    return true;
  } catch {
    return false;
  }
}

export async function discardDlq(id: string): Promise<boolean> {
  const pool = await getPool();
  if (!pool) return false;
  try {
    await pool.query(
      `UPDATE dlq_entries SET status = 'DISCARDED', updated_at = NOW() WHERE id = $1::uuid`,
      [id],
    );
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------
// Budget summary
// ---------------------------------------------------------------------
export type RuntimeBudgetRow = {
  fiscalYear: number;
  category: string;
  allocated: number;
  incurred: number;
  paid: number;
  remaining: number;
};

export async function loadBudgetSummary(year?: number): Promise<RuntimeBudgetRow[] | null> {
  const pool = await getPool();
  if (!pool) return null;
  try {
    const { rows } = await pool.query(
      `SELECT fiscal_year AS fy, category, allocated_amount::float8 AS allocated,
              incurred_amount::float8 AS incurred, paid_amount::float8 AS paid
         FROM budget_lines
        WHERE ($1::int IS NULL OR fiscal_year = $1::int)
        ORDER BY category`,
      [year ?? null],
    );
    return rows.map((row) => ({
      fiscalYear: num(row.fy),
      category: str(row.category),
      allocated: num(row.allocated),
      incurred: num(row.incurred),
      paid: num(row.paid),
      remaining: num(row.allocated) - num(row.incurred),
    }));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// PR/PO workflow — full record shape
// ---------------------------------------------------------------------
export type RuntimeProcurementDetail = RuntimeProcurementRecord & {
  projectCode: string;
  budgetLineId: string;
  fxRate: number;
  paymentTerms: string;
  expectedSettlementAmount: number;
  expectedSettlementMonth: string;
  terms: string;
  legalReviewRequired: boolean;
  securityReviewRequired: boolean;
  legalReviewStatus: string;
  securityReviewStatus: string;
  legalReviewBy: string;
  securityReviewBy: string;
  level1Approver: string;
  level2Approver: string;
  level3Approver: string;
  createdBy: string;
};

const PR_SELECT = `
  SELECT
    pr.id::text AS id, pr.pr_number, COALESCE(pr.po_number,'') AS po_number,
    v.vendor_name AS vendor, pr.region, pr.local_amount::float8 AS amount,
    pr.local_currency AS currency, pr.hkd_amount::float8 AS hkd_amount,
    pr.status, to_char(pr.created_at, 'DD Mon YYYY, HH24:MI') AS created_at,
    pr.project_code, pr.budget_line_id::text AS budget_line_id,
    pr.fx_rate::float8 AS fx_rate, pr.payment_terms, pr.terms,
    COALESCE(pr.expected_settlement_amount,0)::float8 AS expected_settlement_amount,
    pr.expected_settlement_month AS expected_settlement_month,
    COALESCE(pr.legal_review_required,false) AS legal_review_required,
    COALESCE(pr.security_review_required,false) AS security_review_required,
    pr.legal_review_status, pr.security_review_status,
    pr.legal_review_by::text AS legal_review_by, pr.security_review_by::text AS security_review_by,
    pr.level_1_approver::text AS level_1_approver,
    pr.level_2_approver::text AS level_2_approver,
    pr.level_3_approver::text AS level_3_approver,
    pr.created_by::text AS created_by
  FROM procurement_records pr
  LEFT JOIN vendors v ON v.id = pr.vendor_id`;

const mapProcurementDetail = (row: Record<string, unknown>): RuntimeProcurementDetail => {
  const statusKey = str(row.status) || "PR_DRAFT";
  const label = STATUS_LABEL[statusKey] ?? statusKey;
  return {
    id: str(row.id),
    prNumber: str(row.pr_number),
    poNumber: str(row.po_number),
    vendor: str(row.vendor),
    region: str(row.region),
    amount: num(row.amount),
    currency: str(row.currency),
    hkdAmount: num(row.hkd_amount),
    status: label,
    match: statusKey === "VARIANCE_BLOCKED" ? "Variance" : "Matched",
    createdAt: str(row.created_at),
    projectCode: str(row.project_code),
    budgetLineId: str(row.budget_line_id),
    fxRate: num(row.fx_rate),
    paymentTerms: str(row.payment_terms),
    terms: str(row.terms),
    expectedSettlementAmount: num(row.expected_settlement_amount),
    expectedSettlementMonth: str(row.expected_settlement_month),
    legalReviewRequired: Boolean(row.legal_review_required),
    securityReviewRequired: Boolean(row.security_review_required),
    legalReviewStatus: str(row.legal_review_status),
    securityReviewStatus: str(row.security_review_status),
    legalReviewBy: str(row.legal_review_by),
    securityReviewBy: str(row.security_review_by),
    level1Approver: str(row.level_1_approver),
    level2Approver: str(row.level_2_approver),
    level3Approver: str(row.level_3_approver),
    createdBy: str(row.created_by),
  };
};

export async function getProcurementById(
  id: string,
): Promise<RuntimeProcurementDetail | null> {
  const pool = await getPool();
  if (!pool) return null;
  try {
    const { rows } = await pool.query(`${PR_SELECT} WHERE pr.id = $1::uuid`, [id]);
    if (!rows.length) return null;
    return mapProcurementDetail(rows[0]);
  } catch {
    return null;
  }
}

// Budget pre-check: does the budget line have enough remaining for this HKD amount?
export type BudgetCheck = { ok: boolean; remaining: number; reason?: string };

export async function checkBudgetAvailability(
  budgetLineId: string,
  hkdAmount: number,
): Promise<BudgetCheck> {
  const pool = await getPool();
  if (!pool) return { ok: true, remaining: 0, reason: "DB not configured; skipped" };
  try {
    const { rows } = await pool.query(
      `SELECT allocated_amount::float8 AS allocated, incurred_amount::float8 AS incurred
         FROM budget_lines WHERE id = $1::uuid`,
      [budgetIdValid(budgetLineId)],
    );
    const row = rows[0];
    if (!row) return { ok: false, remaining: 0, reason: "Budget line not found" };
    const remaining = num(row.allocated) - num(row.incurred);
    if (hkdAmount > remaining) {
      return {
        ok: false,
        remaining,
        reason: `Insufficient budget: HKD ${hkdAmount.toLocaleString()} requested but only HKD ${remaining.toLocaleString()} remaining`,
      };
    }
    return { ok: true, remaining };
  } catch {
    return { ok: true, remaining: 0, reason: "DB unavailable; skipped" };
  }
}

function budgetIdValid(id: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? id
    : "00000000-0000-0000-0000-000000000000";
}

export async function createProcurementRecord(
  input: Record<string, unknown>,
): Promise<RuntimeProcurementDetail | null> {
  const pool = await getPool();
  if (!pool) return null;
  const prNumber = `PR-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
  try {
    const { rows } = await pool.query(
      `INSERT INTO procurement_records (
         pr_number, project_code, vendor_id, budget_line_id, region, local_currency,
         local_amount, hkd_amount, fx_rate, payment_terms, expected_settlement_amount,
         expected_settlement_month, terms, delivery_address, tax_id,
         created_by, level_1_approver, level_2_approver, level_3_approver, status
       ) VALUES (
         $1, $2, $3::uuid, $4::uuid, $5, $6, $7, $8, $9,
         $10, $11, $12, $13, $14, $15, $16::uuid, $17::uuid, $18::uuid, $19::uuid,
         'PR_DRAFT'
       )
       RETURNING id::text`,
      [
        prNumber,
        String(input.projectCode),
        String(input.vendorId),
        String(input.budgetLineId),
        String(input.region),
        String(input.localCurrency),
        num(input.localAmount),
        num(input.hkdAmount),
        num(input.fxRate),
        input.paymentTerms ? String(input.paymentTerms) : null,
        input.expectedSettlementAmount != null ? num(input.expectedSettlementAmount) : null,
        input.expectedSettlementMonth ? String(input.expectedSettlementMonth) : null,
        input.terms ? String(input.terms) : null,
        input.deliveryAddress ? String(input.deliveryAddress) : null,
        input.taxId ? String(input.taxId) : null,
        input.createdBy ? String(input.createdBy) : null,
        input.level1Approver ? String(input.level1Approver) : null,
        input.level2Approver ? String(input.level2Approver) : null,
        input.level3Approver ? String(input.level3Approver) : null,
      ],
    );
    const id = str(rows[0]?.id);
    return id ? getProcurementById(id) : null;
  } catch {
    return null;
  }
}

// Tiered status transition with legal/security gating and budget coupling.
export type StatusTransitionResult =
  | { ok: true; record: RuntimeProcurementDetail | null }
  | { ok: false; error: string; code?: string };

const STATUS_ORDER: string[] = [
  "PR_DRAFT",
  "PR_APPROVED",
  "PO_ISSUED",
  "MILESTONE_RECEIVED",
  "INVOICE_PENDING",
  "PAYMENT_APPROVED",
  "PAID",
];

export async function advanceProcurementStatus(
  id: string,
  toStatus: string,
  actorId: string,
): Promise<StatusTransitionResult> {
  const record = await getProcurementById(id);
  if (!record) return { ok: false, error: "Procurement record not found", code: "NOT_FOUND" };

  const currentKey = STATUS_LABEL_TO_KEY(record.status) ?? "PR_DRAFT";
  const targetKey = toStatus as string;
  const targetIdx = STATUS_ORDER.indexOf(targetKey);
  const currentIdx = STATUS_ORDER.indexOf(currentKey);

  if (targetIdx < 0) return { ok: false, error: "Unknown target status", code: "BAD_STATUS" };
  if (targetIdx <= currentIdx) {
    return { ok: false, error: "Cannot move to an earlier status", code: "BAD_TRANSITION" };
  }

  // Legal / security review gating: cannot progress past PR_APPROVED / to PO_ISSUED
  // with a pending or rejected review when a review is required.
  const needReviews =
    record.legalReviewRequired || record.securityReviewRequired;
  const legalOk = !record.legalReviewRequired || record.legalReviewStatus === "APPROVED";
  const secOk = !record.securityReviewRequired || record.securityReviewStatus === "APPROVED";

  const requiresReviewsBeforeIssue = targetIdx >= STATUS_ORDER.indexOf("PO_ISSUED");
  if (requiresReviewsBeforeIssue && needReviews && (!legalOk || !secOk)) {
    const pending = [
      !legalOk && "legal",
      !secOk && "security",
    ].filter(Boolean).join(" and ");
    return {
      ok: false,
      error: `Blocked: ${pending} review not approved yet`,
      code: "REVIEW_GATING",
    };
  }

  // Tiered approval enforcement at each transition.
  const hkd = record.hkdAmount;
  if (targetKey === "PR_APPROVED" && hkd > 100_000 && !record.level2Approver) {
    return {
      ok: false,
      error: "Level 2 approval (Deputy Head of IT) required for HKD > 100,000",
      code: "APPROVAL_TIER",
    };
  }
  if (targetKey === "PO_ISSUED" && hkd > 500_000 && !record.level3Approver) {
    return {
      ok: false,
      error: "Level 3 approval (Head of IT) required for HKD > 500,000",
      code: "APPROVAL_TIER",
    };
  }

  // Budget availability check when committing (moving to PR_APPROVED / PO_ISSUED).
  if ((targetKey === "PR_APPROVED" || targetKey === "PO_ISSUED") && record.budgetLineId) {
    const check = await checkBudgetAvailability(record.budgetLineId, hkd);
    if (!check.ok) {
      return { ok: false, error: check.reason ?? "Insufficient budget", code: "BUDGET" };
    }
  }

  const pool = await getPool();
  if (!pool) return { ok: false, error: "DB not configured", code: "DB_UNAVAILABLE" };
  try {
    await pool.query(
      `UPDATE procurement_records SET status = $2 WHERE id = $1::uuid`,
      [id, targetKey],
    );
  } catch {
    return { ok: false, error: "Failed to update status", code: "DB_ERROR" };
  }
  return { ok: true, record: await getProcurementById(id) };
}

function STATUS_LABEL_TO_KEY(label: string): string | undefined {
  const entry = Object.entries(STATUS_LABEL).find(([, l]) => l === label);
  return entry?.[0];
}

// Legal / security review submission.
export async function submitReview(
  id: string,
  reviewType: "legal" | "security",
  decision: "APPROVED" | "REJECTED",
  reviewerId: string,
): Promise<StatusTransitionResult> {
  const record = await getProcurementById(id);
  if (!record) return { ok: false, error: "Procurement record not found", code: "NOT_FOUND" };

  const required =
    reviewType === "legal" ? record.legalReviewRequired : record.securityReviewRequired;
  if (!required) {
    return {
      ok: false,
      error: `No ${reviewType} review required for this record`,
      code: "REVIEW_NOT_REQUIRED",
    };
  }

  const pool = await getPool();
  if (!pool) return { ok: false, error: "DB not configured", code: "DB_UNAVAILABLE" };
  try {
    const col =
      reviewType === "legal" ? "legal_review_status" : "security_review_status";
    const byCol = reviewType === "legal" ? "legal_review_by" : "security_review_by";
    const atCol = reviewType === "legal" ? "legal_review_at" : "security_review_at";
    await pool.query(
      `UPDATE procurement_records
          SET ${col} = $2, ${byCol} = $3::uuid, ${atCol} = NOW()
        WHERE id = $1::uuid`,
      [id, decision, reviewerId],
    );
  } catch {
    return { ok: false, error: "Failed to submit review", code: "DB_ERROR" };
  }
  return { ok: true, record: await getProcurementById(id) };
}

// ---------------------------------------------------------------------
// Payment schedules + three-way match
// ---------------------------------------------------------------------
export type RuntimePaymentSchedule = {
  id: string;
  procurementId: string;
  dueDate: string;
  amount: number;
  isMilestonePayment: boolean;
  milestoneNumber: number;
  milestoneDescription: string;
  invoiceAmount: number;
  invoiceNumber: string;
  isVarianceDetected: boolean;
  varianceType: string;
  varianceAmount: number;
  varianceResolutionNotes: string;
  dualSignoffAt: string;
  paidAt: string;
  paidAmount: number;
  paymentReference: string;
  threeWayMatch: string;
  confirmationStatus: string;
  confirmationNote: string;
  confirmedAt: string;
};

const PAYMENT_SELECT = `
  SELECT ps.id::text AS id, ps.procurement_id::text AS procurement_id,
         to_char(ps.due_date,'YYYY-MM-DD') AS due_date, ps.amount::float8 AS amount,
         COALESCE(ps.is_milestone_payment,false) AS is_milestone_payment,
         ps.milestone_number AS milestone_number, ps.milestone_description,
         COALESCE(ps.invoice_amount,0)::float8 AS invoice_amount, ps.invoice_number,
         COALESCE(ps.is_variance_detected,false) AS is_variance_detected,
         ps.variance_type, COALESCE(ps.variance_amount,0)::float8 AS variance_amount,
         ps.variance_resolution_notes, ps.dual_signoff_at,
         to_char(ps.paid_at,'YYYY-MM-DD') AS paid_at,
         COALESCE(ps.paid_amount,0)::float8 AS paid_amount, ps.payment_reference,
          CASE WHEN ps.vendor_confirmed_at IS NULL THEN 'PENDING' ELSE 'CONFIRMED' END AS confirmation_status,
          ps.vendor_confirmation_note AS confirmation_note,
          ps.vendor_confirmed_at AS confirmed_at,
         (SELECT status::text FROM three_way_matches tw
           WHERE tw.payment_schedule_id = ps.id ORDER BY tw.created_at DESC LIMIT 1) AS three_way_match
    FROM payment_schedules ps`;

const mapPayment = (row: Record<string, unknown>): RuntimePaymentSchedule => ({
  id: str(row.id),
  procurementId: str(row.procurement_id),
  dueDate: str(row.due_date),
  amount: num(row.amount),
  isMilestonePayment: Boolean(row.is_milestone_payment),
  milestoneNumber: num(row.milestone_number),
  milestoneDescription: str(row.milestone_description),
  invoiceAmount: num(row.invoice_amount),
  invoiceNumber: str(row.invoice_number),
  isVarianceDetected: Boolean(row.is_variance_detected),
  varianceType: str(row.variance_type),
  varianceAmount: num(row.variance_amount),
  varianceResolutionNotes: str(row.variance_resolution_notes),
  dualSignoffAt: str(row.dual_signoff_at),
  paidAt: str(row.paid_at),
  paidAmount: num(row.paid_amount),
  paymentReference: str(row.payment_reference),
  threeWayMatch: str(row.three_way_match),
  confirmationStatus: str(row.confirmation_status) || "PENDING",
  confirmationNote: str(row.confirmation_note),
  confirmedAt: str(row.confirmed_at),
});

export async function listPaymentSchedules(
  procurementId: string,
  options: { throwOnError?: boolean } = {},
): Promise<RuntimePaymentSchedule[] | null> {
  const pool = await getPool();
  if (!pool) return null;
  try {
    const { rows } = await pool.query(
      `${PAYMENT_SELECT} WHERE ps.procurement_id = $1::uuid ORDER BY ps.milestone_number NULLS FIRST, ps.due_date`,
      [procurementId],
    );
    return rows.map(mapPayment);
  } catch (error) {
    if (options.throwOnError) {
      throw new Error("Payment schedule database query failed", { cause: error });
    }
    return null;
  }
}

export type RuntimeVendorPortalPurchaseOrder = RuntimeProcurementDetail & {
  milestones: RuntimePaymentSchedule[];
};

export async function loadVendorPortalPurchaseOrders(
  vendorId: string,
): Promise<RuntimeVendorPortalPurchaseOrder[] | null> {
  const pool = await getPool();
  if (!pool) return null;
  try {
    const { rows } = await pool.query(
      `${PR_SELECT}
        WHERE pr.vendor_id = $1::uuid
          AND NULLIF(BTRIM(pr.po_number), '') IS NOT NULL
          AND pr.status IN (
            'PO_ISSUED',
            'MILESTONE_RECEIVED',
            'INVOICE_PENDING',
            'VARIANCE_BLOCKED',
            'PAYMENT_APPROVED',
            'PAID'
          )
        ORDER BY pr.created_at DESC`,
      [vendorId],
    );
    const records = rows.map(mapProcurementDetail);
    return Promise.all(records.map(async (record) => {
      const schedules = (await listPaymentSchedules(record.id, { throwOnError: true })) ?? [];
      return {
        ...record,
        milestones: schedules,
      };
    }));
  } catch (error) {
    throw new Error("Vendor portal database query failed", { cause: error });
  }
}

export async function getPaymentSchedule(
  id: string,
  options: { throwOnError?: boolean } = {},
): Promise<RuntimePaymentSchedule | null> {
  const pool = await getPool();
  if (!pool) return null;
  try {
    const { rows } = await pool.query(`${PAYMENT_SELECT} WHERE ps.id = $1::uuid`, [id]);
    return rows.length ? mapPayment(rows[0]) : null;
  } catch (error) {
    if (options.throwOnError) {
      throw new Error("Payment schedule database query failed", { cause: error });
    }
    return null;
  }
}

export async function createPaymentSchedule(
  procurementId: string,
  input: Record<string, unknown>,
): Promise<RuntimePaymentSchedule | null> {
  const pool = await getPool();
  if (!pool) return null;
  const amount = num(input.amount);
  try {
    const { rows } = await pool.query(
      `INSERT INTO payment_schedules (
         procurement_id, due_date, amount, milestone_number, milestone_description, is_milestone_payment
       ) VALUES (
         $1::uuid, $2::date, $3, $4, $5, $6
       )
       RETURNING id::text`,
      [
        procurementId,
        String(input.dueDate),
        amount,
        input.milestoneNumber != null ? num(input.milestoneNumber) : null,
        input.milestoneDescription ? String(input.milestoneDescription) : null,
        Boolean(input.isMilestonePayment),
      ],
    );
    const id = str(rows[0]?.id);
    return id ? getPaymentSchedule(id) : null;
  } catch {
    return null;
  }
}

// Submit invoice (OCR) -> triggers three-way match at DB layer.
export async function submitInvoice(
  id: string,
  input: Record<string, unknown>,
): Promise<RuntimePaymentSchedule | null> {
  const pool = await getPool();
  if (!pool) return null;
  try {
    await pool.query(
      `UPDATE payment_schedules
          SET invoice_amount = $2, invoice_number = $3,
              invoice_date = COALESCE($4::date, NOW()),
              ocr_invoice_data = COALESCE($5::jsonb, ocr_invoice_data)
        WHERE id = $1::uuid`,
      [
        id,
        num(input.invoiceAmount),
        String(input.invoiceNumber),
        input.invoiceDate ? String(input.invoiceDate) : null,
        input.ocrInvoiceData ? JSON.stringify(input.ocrInvoiceData) : null,
      ],
    );
  } catch {
    return null;
  }
  return getPaymentSchedule(id);
}

export async function submitVendorInvoice(
  id: string,
  procurementId: string,
  input: Record<string, unknown>,
): Promise<RuntimePaymentSchedule | null> {
  const pool = await getPool();
  if (!pool) return null;
  try {
    const { rows } = await pool.query(
      `UPDATE payment_schedules ps
          SET invoice_amount = $3,
              invoice_number = $4,
              invoice_date = COALESCE($5::date, NOW()),
              updated_at = NOW()
         FROM procurement_records pr
        WHERE ps.id = $1::uuid
          AND ps.procurement_id = $2::uuid
          AND pr.id = ps.procurement_id
          AND NULLIF(BTRIM(pr.po_number), '') IS NOT NULL
          AND pr.status IN (
            'PO_ISSUED',
            'MILESTONE_RECEIVED',
            'INVOICE_PENDING',
            'VARIANCE_BLOCKED',
            'PAYMENT_APPROVED',
            'PAID'
          )
          AND ps.invoice_number IS NULL
          AND ps.paid_at IS NULL
        RETURNING ps.id::text AS id`,
      [
        id,
        procurementId,
        num(input.invoiceAmount),
        String(input.invoiceNumber),
        input.invoiceDate ? String(input.invoiceDate) : null,
      ],
    );
    return rows.length
      ? getPaymentSchedule(str(rows[0].id), { throwOnError: true })
      : null;
  } catch {
    return null;
  }
}

export async function confirmVendorMilestone(
  id: string,
  confirmationNote = "",
): Promise<RuntimePaymentSchedule | null> {
  const pool = await getPool();
  if (!pool) return null;
  try {
    const { rows } = await pool.query(
      `UPDATE payment_schedules
          SET vendor_confirmed_at = NOW(),
              vendor_confirmation_note = $2,
              updated_at = NOW()
        WHERE id = $1::uuid
          AND is_milestone_payment = TRUE
          AND vendor_confirmed_at IS NULL
          AND EXISTS (
            SELECT 1
              FROM procurement_records pr
             WHERE pr.id = payment_schedules.procurement_id
               AND NULLIF(BTRIM(pr.po_number), '') IS NOT NULL
               AND pr.status IN (
                 'PO_ISSUED',
                 'MILESTONE_RECEIVED',
                 'INVOICE_PENDING',
                 'VARIANCE_BLOCKED',
                 'PAYMENT_APPROVED',
                 'PAID'
               )
          )
        RETURNING procurement_id::text AS procurement_id`,
      [id, confirmationNote],
    );
    const procurementId = str(rows[0]?.procurement_id);
    if (!procurementId) return null;
    await pool.query(
      `UPDATE procurement_records
          SET status = CASE
            WHEN status = 'PO_ISSUED' THEN 'MILESTONE_RECEIVED'
            ELSE status
          END,
          updated_at = NOW()
        WHERE id = $1::uuid`,
      [procurementId],
    );
  } catch {
    return null;
  }
  return getPaymentSchedule(id, { throwOnError: true });
}

// Resolve a blocked variance (finance + legal consultation).
export async function resolveVariance(
  id: string,
  resolvedBy: string,
  resolutionNotes: string,
): Promise<StatusTransitionResult & { schedule?: RuntimePaymentSchedule | null }> {
  const schedule = await getPaymentSchedule(id);
  if (!schedule) return { ok: false, error: "Payment schedule not found", code: "NOT_FOUND" };
  if (!schedule.isVarianceDetected) {
    return { ok: false, error: "No variance to resolve on this schedule", code: "NO_VARIANCE" };
  }
  const pool = await getPool();
  if (!pool) return { ok: false, error: "DB not configured", code: "DB_UNAVAILABLE" };
  try {
    await pool.query(
      `UPDATE payment_schedules
          SET is_variance_detected = FALSE, variance_resolution_notes = $2,
              variance_resolved_by = $3::uuid, variance_resolved_at = NOW()
        WHERE id = $1::uuid`,
      [id, resolutionNotes, resolvedBy],
    );
    // If no remaining blocked schedules, release the procurement from VARIANCE_BLOCKED.
    const procResult = await pool.query(
      `UPDATE procurement_records pr
          SET status = 'INVOICE_PENDING', updated_at = NOW()
        WHERE pr.id = (SELECT procurement_id FROM payment_schedules WHERE id = $1::uuid)
          AND pr.status = 'VARIANCE_BLOCKED'
          AND NOT EXISTS (
            SELECT 1 FROM payment_schedules ps
             WHERE ps.procurement_id = pr.id AND ps.is_variance_detected AND ps.id <> $1::uuid
          )`,
      [id],
    );
    void procResult;
  } catch {
    return { ok: false, error: "Failed to resolve variance", code: "DB_ERROR" };
  }
  return { ok: true, record: null, schedule: await getPaymentSchedule(id) };
}

// Dual sign-off (Head of IT + Finance Auditor) for payments > 250k.
export async function dualSignoff(
  id: string,
  headId: string,
  financeId: string,
): Promise<StatusTransitionResult & { schedule?: RuntimePaymentSchedule | null }> {
  const schedule = await getPaymentSchedule(id);
  if (!schedule) return { ok: false, error: "Payment schedule not found", code: "NOT_FOUND" };
  if (schedule.amount <= 250_000) {
    return {
      ok: false,
      error: "Dual sign-off not required for payments at or below HKD 250,000",
      code: "SIGNOFF_NOT_REQUIRED",
    };
  }
  const pool = await getPool();
  if (!pool) return { ok: false, error: "DB not configured", code: "DB_UNAVAILABLE" };
  try {
    await pool.query(
      `UPDATE payment_schedules
          SET dual_signoff_head_id = $2::uuid, dual_signoff_finance_id = $3::uuid,
              dual_signoff_at = NOW()
        WHERE id = $1::uuid`,
      [id, headId, financeId],
    );
  } catch {
    return { ok: false, error: "Failed to record dual sign-off", code: "DB_ERROR" };
  }
  return { ok: true, record: null, schedule: await getPaymentSchedule(id) };
}

// Mark a payment as paid (triggers budget paid_amount via DB trigger).
export async function markPaid(
  id: string,
  paidAmount: number,
  paymentReference: string,
): Promise<StatusTransitionResult & { schedule?: RuntimePaymentSchedule | null }> {
  const schedule = await getPaymentSchedule(id);
  if (!schedule) return { ok: false, error: "Payment schedule not found", code: "NOT_FOUND" };
  if (schedule.isVarianceDetected) {
    return {
      ok: false,
      error: "Variance must be resolved before payment",
      code: "VARIANCE_BLOCKED",
    };
  }
  if (schedule.amount > 250_000 && !schedule.dualSignoffAt) {
    return {
      ok: false,
      error: "Dual sign-off (Head of IT + Finance) required before payment",
      code: "SIGNOFF_REQUIRED",
    };
  }
  const pool = await getPool();
  if (!pool) return { ok: false, error: "DB not configured", code: "DB_UNAVAILABLE" };
  try {
    await pool.query(
      `UPDATE payment_schedules
          SET paid_at = NOW(), paid_amount = $2, payment_reference = $3
        WHERE id = $1::uuid`,
      [id, paidAmount, paymentReference],
    );
  } catch {
    return { ok: false, error: "Failed to mark payment", code: "DB_ERROR" };
  }
  return { ok: true, record: null, schedule: await getPaymentSchedule(id) };
}

// ---------------------------------------------------------------------
// Three-way match detail
// ---------------------------------------------------------------------
export type RuntimeThreeWayMatch = {
  id: string;
  procurementId: string;
  paymentScheduleId: string;
  poAmount: number;
  invoiceAmount: number;
  milestoneAmount: number;
  priceVariance: number;
  shippingTaxVariance: number;
  status: string;
  matchedAt: string;
  notes: string;
};

export async function getThreeWayMatch(
  paymentScheduleId: string,
): Promise<RuntimeThreeWayMatch | null> {
  const pool = await getPool();
  if (!pool) return null;
  try {
    const { rows } = await pool.query(
      `SELECT tw.id::text AS id, tw.procurement_id::text AS procurement_id,
              tw.payment_schedule_id::text AS payment_schedule_id,
              tw.po_amount::float8 AS po_amount, tw.invoice_amount::float8 AS invoice_amount,
              tw.milestone_amount::float8 AS milestone_amount,
              tw.price_variance::float8 AS price_variance,
              COALESCE(tw.shipping_tax_variance,0)::float8 AS shipping_tax_variance,
              tw.status, tw.matched_at, tw.notes
         FROM three_way_matches tw
        WHERE tw.payment_schedule_id = $1::uuid
        ORDER BY tw.created_at DESC LIMIT 1`,
      [paymentScheduleId],
    );
    if (!rows.length) return null;
    const row = rows[0];
    return {
      id: str(row.id),
      procurementId: str(row.procurement_id),
      paymentScheduleId: str(row.payment_schedule_id),
      poAmount: num(row.po_amount),
      invoiceAmount: num(row.invoice_amount),
      milestoneAmount: num(row.milestone_amount),
      priceVariance: num(row.price_variance),
      shippingTaxVariance: num(row.shipping_tax_variance),
      status: str(row.status),
      matchedAt: str(row.matched_at),
      notes: str(row.notes),
    };
  } catch {
    return null;
  }
}
