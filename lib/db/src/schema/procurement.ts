import {
  pgTable,
  uuid,
  text,
  varchar,
  numeric,
  boolean,
  timestamp,
  uniqueIndex,
  index,
  jsonb,
  date,
  integer,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { regionCode, prPoStatus, reviewStatus } from "./enums";
import { profiles } from "./profiles";
import { budgetLines } from "./budget";

export const vendors = pgTable(
  "vendors",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuid_generate_v4()`),
    vendorName: text("vendor_name").notNull(),
    region: regionCode("region").notNull(),
    contact: text("contact"),
    deliveryAddress: text("delivery_address"),
    paymentTerms: text("payment_terms"),
    taxId: text("tax_id"),
    apiKeyHash: text("api_key_hash"),
    createdBy: uuid("created_by").references(() => profiles.id),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`NOW()`),
  },
  (table) => [uniqueIndex("vendors_api_key_hash_key").on(table.apiKeyHash)],
);

export const procurementRecords = pgTable(
  "procurement_records",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuid_generate_v4()`),
    prNumber: text("pr_number").notNull(),
    poNumber: text("po_number"),
    projectCode: text("project_code").notNull(),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id),
    budgetLineId: uuid("budget_line_id").references(() => budgetLines.id),
    region: regionCode("region").notNull(),
    localCurrency: varchar("local_currency", { length: 3 }).notNull(),
    localAmount: numeric("local_amount", { precision: 15, scale: 2 }).notNull(),
    hkdAmount: numeric("hkd_amount", { precision: 15, scale: 2 }).notNull(),
    fxRate: numeric("fx_rate", { precision: 18, scale: 6 }).notNull(),
    paymentTerms: text("payment_terms"),
    expectedSettlementAmount: numeric("expected_settlement_amount", { precision: 15, scale: 2 }),
    expectedSettlementMonth: text("expected_settlement_month"),
    terms: text("terms"),
    deliveryAddress: text("delivery_address"),
    taxId: text("tax_id"),
    status: prPoStatus("status").default("PR_DRAFT"),
    legalReviewRequired: boolean("legal_review_required").default(false),
    securityReviewRequired: boolean("security_review_required").default(false),
    legalReviewStatus: reviewStatus("legal_review_status").default("PENDING"),
    securityReviewStatus: reviewStatus("security_review_status").default("PENDING"),
    legalReviewBy: uuid("legal_review_by").references(() => profiles.id),
    securityReviewBy: uuid("security_review_by").references(() => profiles.id),
    legalReviewAt: timestamp("legal_review_at", { withTimezone: true }),
    securityReviewAt: timestamp("security_review_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => profiles.id),
    level1Approver: uuid("level_1_approver").references(() => profiles.id),
    level2Approver: uuid("level_2_approver").references(() => profiles.id),
    level3Approver: uuid("level_3_approver").references(() => profiles.id),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`NOW()`),
  },
  (table) => [
    uniqueIndex("procurement_records_pr_number_key").on(table.prNumber),
    uniqueIndex("procurement_records_po_number_key").on(table.poNumber),
    index("procurement_records_project_code_idx").on(table.projectCode),
    index("procurement_records_legal_review_idx").on(table.legalReviewStatus),
    index("procurement_records_security_review_idx").on(table.securityReviewStatus),
  ],
);

export const costAllocations = pgTable(
  "cost_allocations",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuid_generate_v4()`),
    procurementId: uuid("procurement_id").references(() => procurementRecords.id, {
      onDelete: "cascade",
    }),
    businessUnit: text("business_unit").notNull(),
    percentageShare: numeric("percentage_share", { precision: 5, scale: 2 }).notNull(),
  },
  (table) => [
    index("cost_allocations_procurement_id_idx").on(table.procurementId),
    {
      percentageCheck: sql`CHECK (percentage_share > 0 AND percentage_share <= 100)`,
    },
  ],
);

export const paymentSchedules = pgTable(
  "payment_schedules",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuid_generate_v4()`),
    procurementId: uuid("procurement_id").references(() => procurementRecords.id, {
      onDelete: "cascade",
    }),
    dueDate: timestamp("due_date", { mode: "date" }).notNull(),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    // Milestone tracking
    milestoneNumber: integer("milestone_number"),
    milestoneDescription: text("milestone_description"),
    isMilestonePayment: boolean("is_milestone_payment").default(false),
    vendorConfirmationNote: text("vendor_confirmation_note"),
    vendorConfirmedAt: timestamp("vendor_confirmed_at", { withTimezone: true }),
    // OCR Invoice Processing
    ocrInvoiceData: jsonb("ocr_invoice_data"),
    invoiceAmount: numeric("invoice_amount", { precision: 15, scale: 2 }),
    invoiceDate: timestamp("invoice_date", { mode: "date" }),
    invoiceNumber: text("invoice_number"),
    // Variance & Resolution
    isVarianceDetected: boolean("is_variance_detected").default(false),
    varianceType: text("variance_type"),
    varianceAmount: numeric("variance_amount", { precision: 15, scale: 2 }),
    varianceResolutionNotes: text("variance_resolution_notes"),
    varianceResolvedBy: uuid("variance_resolved_by").references(() => profiles.id),
    varianceResolvedAt: timestamp("variance_resolved_at", { withTimezone: true }),
    // Dual Sign-off (for payments > 250,000 HKD)
    dualSignoffHeadId: uuid("dual_signoff_head_id").references(() => profiles.id),
    dualSignoffFinanceId: uuid("dual_signoff_finance_id").references(() => profiles.id),
    dualSignoffAt: timestamp("dual_signoff_at", { withTimezone: true }),
    // Payment tracking
    paidAt: timestamp("paid_at", { withTimezone: true }),
    paidAmount: numeric("paid_amount", { precision: 15, scale: 2 }),
    paymentReference: text("payment_reference"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`NOW()`),
  },
  (table) => [
    index("payment_schedules_procurement_id_idx").on(table.procurementId),
    index("payment_schedules_milestone_idx").on(table.milestoneNumber),
    index("payment_schedules_variance_idx").on(table.isVarianceDetected),
  ],
);
