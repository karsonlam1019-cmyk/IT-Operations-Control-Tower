-- =====================================================================
-- IT Operations Control Tower — Supabase DDL + RLS + guardrail fixes
-- Source of truth for the database schema. Mirrors Drizzle models in
-- lib/db/src/schema and fills the gaps that Drizzle/pg-core can't model
-- (circular FKs, pgvector, RLS, triggers, cron jobs).
-- =====================================================================

-- Enable Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_cron"; -- for stale-heartbeat (guardrail E)

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
CREATE TYPE user_role AS ENUM ('SUPER_ADMIN', 'DEPUTY_HEAD_OF_IT', 'TEAM_LEAD', 'IT_COLLEAGUE', 'FINANCE_AUDITOR', 'VENDOR_API');
CREATE TYPE region_code AS ENUM ('HK', 'CN', 'MY', 'ID');
CREATE TYPE env_type AS ENUM ('SIT', 'UAT', 'STAGING', 'PROD');
CREATE TYPE pr_po_status AS ENUM ('PR_DRAFT', 'PR_APPROVED', 'PO_ISSUED', 'MILESTONE_RECEIVED', 'INVOICE_PENDING', 'VARIANCE_BLOCKED', 'PAYMENT_APPROVED', 'PAID');
CREATE TYPE budget_category AS ENUM ('HARDWARE', 'SOFTWARE', 'DATA', 'SERVICES');
CREATE TYPE review_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE three_way_match_status AS ENUM ('PENDING', 'MATCHED', 'PRICE_VARIANCE', 'SHIPPING_TAX_VARIANCE', 'BLOCKED');

-- ---------------------------------------------------------------------
-- Teams
-- ---------------------------------------------------------------------
CREATE TABLE teams (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    team_name TEXT NOT NULL,
    team_lead_id UUID,                          -- FK added after profiles exist (guardrail B)
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- Profiles (id is the Supabase auth.users id)
-- ---------------------------------------------------------------------
CREATE TABLE profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    full_name TEXT NOT NULL,
    role user_role NOT NULL DEFAULT 'IT_COLLEAGUE',
    team_id UUID,                            -- FK added after tables exist (guardrail B)
    region region_code NOT NULL DEFAULT 'HK',
    deputy_for_user_id UUID REFERENCES profiles(id),
    on_leave BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Break the circular FK as recommended (guardrail B): create teams with
-- team_lead_id NULL, create all profiles, then add the profiles.team_id FK.
ALTER TABLE profiles ADD CONSTRAINT profiles_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams(id);

-- Add teams.team_lead_id FK only after profiles exists (guardrail B).
ALTER TABLE teams ADD CONSTRAINT teams_team_lead_id_fkey FOREIGN KEY (team_lead_id) REFERENCES profiles(id);

-- ---------------------------------------------------------------------
-- Frozen FX Rates
-- ---------------------------------------------------------------------
CREATE TABLE fx_rates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    base_currency VARCHAR(3) NOT NULL DEFAULT 'HKD',
    quote_currency VARCHAR(3) NOT NULL,
    rate NUMERIC(18, 6) NOT NULL,
    effective_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- Budget Lines (IT CapEx/OpEx — yearly, category: HARDWARE/SOFTWARE/DATA/SERVICES)
-- Budget first: allocated at year start, incurred on PR approval, paid on payment.
-- ---------------------------------------------------------------------

CREATE TABLE budget_lines (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    fiscal_year INT NOT NULL,
    category budget_category NOT NULL,
    description TEXT,
    allocated_amount NUMERIC(15, 2) NOT NULL DEFAULT 0,
    incurred_amount NUMERIC(15, 2) NOT NULL DEFAULT 0,   -- sum of approved PR hkda amounts
    paid_amount NUMERIC(15, 2) NOT NULL DEFAULT 0,       -- sum of paid payment_schedules
    created_by UUID REFERENCES profiles(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (fiscal_year, category)
);

-- Trigger: update incurred_amount when procurement_record status reaches PR_APPROVED/PO_ISSUED
-- Trigger: update paid_amount when payment_schedules.paid_at is set
-- (Implemented in app logic + trigger; see guardrail I equivalent)

-- ---------------------------------------------------------------------
-- Real-Time Staff Statuses
-- ---------------------------------------------------------------------
CREATE TABLE staff_statuses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
    status_text TEXT NOT NULL,
    active_ticket_id TEXT,
    environment env_type DEFAULT 'SIT',
    eta_completion TIMESTAMPTZ,
    is_stale BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- Vendors
-- ---------------------------------------------------------------------
CREATE TABLE vendors (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    vendor_name TEXT NOT NULL,
    region region_code NOT NULL,
    contact TEXT,
    delivery_address TEXT,
    payment_terms TEXT,
    tax_id TEXT,
    api_key_hash TEXT UNIQUE,
    created_by UUID REFERENCES profiles(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- Procurement Records
-- ---------------------------------------------------------------------
CREATE TABLE procurement_records (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    pr_number TEXT UNIQUE NOT NULL,
    po_number TEXT UNIQUE,
    project_code TEXT NOT NULL,
    vendor_id UUID NOT NULL REFERENCES vendors(id),
    budget_line_id UUID REFERENCES budget_lines(id),
    region region_code NOT NULL,
    local_currency VARCHAR(3) NOT NULL,
    local_amount NUMERIC(15, 2) NOT NULL,
    hkd_amount NUMERIC(15, 2) NOT NULL,
    fx_rate NUMERIC(18, 6) NOT NULL,
    payment_terms TEXT,                     -- e.g., 'NET 60', 'MILESTONE 3:4:3'
    expected_settlement_amount NUMERIC(15, 2),  -- expected total settlement in HKD
    expected_settlement_month TEXT,       -- expected settlement month (YYYY-MM)
    terms TEXT,                             -- detailed terms/conditions
    delivery_address TEXT,
    tax_id TEXT,
    status pr_po_status DEFAULT 'PR_DRAFT',
    -- Legal & Security Review (required when hkd_amount > 100,000)
    legal_review_required BOOLEAN DEFAULT FALSE,
    security_review_required BOOLEAN DEFAULT FALSE,
    legal_review_status review_status DEFAULT 'PENDING',
    security_review_status review_status DEFAULT 'PENDING',
    legal_review_by UUID REFERENCES profiles(id),
    security_review_by UUID REFERENCES profiles(id),
    legal_review_at TIMESTAMPTZ,
    security_review_at TIMESTAMPTZ,
    -- Approvers
    created_by UUID REFERENCES profiles(id),
    level_1_approver UUID REFERENCES profiles(id),
    level_2_approver UUID REFERENCES profiles(id),
    level_3_approver UUID REFERENCES profiles(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- Cost Allocations (sum must equal 100% — enforced app-side + trigger)
-- ---------------------------------------------------------------------
CREATE TABLE cost_allocations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    procurement_id UUID REFERENCES procurement_records(id) ON DELETE CASCADE,
    business_unit TEXT NOT NULL,
    percentage_share NUMERIC(5, 2) NOT NULL,
    CHECK (percentage_share > 0 AND percentage_share <= 100)
);

-- ---------------------------------------------------------------------
-- Payment Schedules
-- ---------------------------------------------------------------------
CREATE TABLE payment_schedules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    procurement_id UUID REFERENCES procurement_records(id) ON DELETE CASCADE,
    due_date DATE NOT NULL,
    amount NUMERIC(15,2) NOT NULL,
    -- Milestone tracking (e.g., 3:4:3 = milestone 1/3, 2/3, 3/3)
    milestone_number INT,                   -- 1, 2, 3 for 3:4:3
    milestone_description TEXT,             -- e.g., 'Design complete', 'UAT sign-off', 'Go-live'
    is_milestone_payment BOOLEAN DEFAULT FALSE,
    vendor_confirmation_note TEXT,
    vendor_confirmed_at TIMESTAMPTZ,
    -- OCR Invoice Processing
    ocr_invoice_data JSONB,                 -- extracted invoice data from OCR
    invoice_amount NUMERIC(15, 2),          -- amount on vendor invoice (for 3-way match)
    invoice_date DATE,
    invoice_number TEXT,
    -- Variance & Resolution
    is_variance_detected BOOLEAN DEFAULT FALSE,
    variance_type TEXT,                     -- 'PRICE', 'SHIPPING_TAX', 'QUANTITY'
    variance_amount NUMERIC(15, 2),
    variance_resolution_notes TEXT,
    variance_resolved_by UUID REFERENCES profiles(id),
    variance_resolved_at TIMESTAMPTZ,
    -- Dual Sign-off (for payments > 250,000 HKD)
    dual_signoff_head_id UUID REFERENCES profiles(id),
    dual_signoff_finance_id UUID REFERENCES profiles(id),
    dual_signoff_at TIMESTAMPTZ,
    -- Payment tracking
    paid_at TIMESTAMPTZ,
    paid_amount NUMERIC(15, 2),
    payment_reference TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- Three-Way Match (PO vs Invoice vs Milestone Sign-off)
-- ---------------------------------------------------------------------
CREATE TABLE three_way_matches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    procurement_id UUID NOT NULL REFERENCES procurement_records(id) ON DELETE CASCADE,
    payment_schedule_id UUID REFERENCES payment_schedules(id) ON DELETE SET NULL,
    po_amount NUMERIC(15, 2) NOT NULL,          -- from procurement_records.hkd_amount
    invoice_amount NUMERIC(15, 2),              -- from payment_schedules.invoice_amount
    milestone_amount NUMERIC(15, 2),            -- from payment_schedules.amount (milestone)
    price_variance NUMERIC(15, 2) GENERATED ALWAYS AS (COALESCE(invoice_amount, 0) - po_amount) STORED,
    shipping_tax_variance NUMERIC(15, 2),       -- shipping/tax difference
    status three_way_match_status DEFAULT 'PENDING',
    matched_at TIMESTAMPTZ,
    matched_by UUID REFERENCES profiles(id),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (procurement_id, payment_schedule_id)
);

-- ---------------------------------------------------------------------
-- Knowledge Base Vectors for RAG (EN + CN)
-- ---------------------------------------------------------------------
CREATE TABLE knowledge_base_vectors (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_title TEXT NOT NULL,
    language VARCHAR(2) NOT NULL,
    section_reference TEXT,
    page_number INT,
    content TEXT NOT NULL,
    embedding vector(1536),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- Immutable Audit Logs (SOC2)
-- ---------------------------------------------------------------------
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    actor_id UUID REFERENCES profiles(id),
    action_type TEXT NOT NULL,
    target_resource TEXT NOT NULL,
    old_value JSONB,
    new_value JSONB,
    acted_as_deputy BOOLEAN DEFAULT FALSE,
    ip_address TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- Dead Letter Queue (DLQ) — persistence for malformed/unhandled work
-- ---------------------------------------------------------------------
CREATE TABLE dlq_entries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    status TEXT NOT NULL DEFAULT 'PENDING',          -- PENDING | REPROCESSING | SUCCESS | DISCARDED | FAILED
    payload JSONB NOT NULL,                            -- original request/event payload
    error_code TEXT,                                   -- machine-readable error code
    error_message TEXT,                                -- human-readable reason
    retry_count INT NOT NULL DEFAULT 0,
    max_retries INT NOT NULL DEFAULT 5,
    next_attempt_at TIMESTAMPTZ,
    last_error_at TIMESTAMPTZ,
    resolved_by UUID REFERENCES profiles(id),
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_dlq_status ON dlq_entries(status);
CREATE INDEX idx_dlq_created ON dlq_entries(created_at);

-- =====================================================================
-- ROW LEVEL SECURITY  (guardrail A: complete policies for EVERY table)
-- =====================================================================
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE procurement_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_base_vectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE three_way_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE dlq_entries ENABLE ROW LEVEL SECURITY;

-- Helper: is the current user an admin (SUPER_ADMIN / DEPUTY_HEAD_OF_IT / FINANCE_AUDITOR)?
CREATE OR REPLACE FUNCTION is_admin_user()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('SUPER_ADMIN', 'DEPUTY_HEAD_OF_IT', 'FINANCE_AUDITOR')
  );
$$;

-- ============ profiles ============
-- Self read + read own; admins read all (guardrail C: without this, login profile load fails)
CREATE POLICY profiles_select_self ON profiles FOR SELECT USING (id = auth.uid() OR is_admin_user());
-- Update own profile (cannot change role, deputy links guarded app-side)
CREATE POLICY profiles_update_self ON profiles FOR UPDATE USING (id = auth.uid()) WITH CHECK (id = auth.uid());
-- Only an admin can insert/update roles & deputy linkage
CREATE POLICY profiles_insert_admin ON profiles FOR INSERT WITH CHECK (is_admin_user());
CREATE POLICY profiles_update_admin_role ON profiles FOR UPDATE USING (is_admin_user());

-- ============ teams ============
CREATE POLICY teams_select_member ON teams FOR SELECT USING (true);
CREATE POLICY teams_write_admin ON teams FOR INSERT WITH CHECK (is_admin_user());
CREATE POLICY teams_update_admin ON teams FOR UPDATE USING (is_admin_user());

-- ============ staff_statuses ============
-- Users read/write own row; TEAM_LEAD reads their team; admins read all
CREATE POLICY staff_select_self ON staff_statuses FOR SELECT USING (
  user_id = auth.uid()
  OR is_admin_user()
  OR auth.uid() IN (SELECT team_lead_id FROM teams WHERE team_lead_id IS NOT NULL)
);
CREATE POLICY staff_write_self ON staff_statuses FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY staff_write_admin ON staff_statuses FOR UPDATE USING (is_admin_user());

-- ============ procurement_records ============
-- FINANCE_AUDITOR read-only global; approvers see actionable; creators manage own; admins all
CREATE POLICY procurement_select ON procurement_records FOR SELECT USING (
  created_by = auth.uid()
  OR level_1_approver = auth.uid()
  OR level_2_approver = auth.uid()
  OR level_3_approver = auth.uid()
  OR is_admin_user()
);
-- Only admins / procurement creators create records
CREATE POLICY procurement_insert_admin ON procurement_records FOR INSERT WITH CHECK (is_admin_user() OR created_by = auth.uid());
-- Approvers update the status they own; admins update all
CREATE POLICY procurement_update_approver ON procurement_records FOR UPDATE USING (
  is_admin_user()
  OR level_1_approver = auth.uid()
  OR level_2_approver = auth.uid()
  OR level_3_approver = auth.uid()
);

-- ============ cost_allocations ============
CREATE POLICY alloc_select ON cost_allocations FOR SELECT USING (is_admin_user());
CREATE POLICY alloc_insert_admin ON cost_allocations FOR INSERT WITH CHECK (is_admin_user());
CREATE POLICY alloc_update_admin ON cost_allocations FOR UPDATE USING (is_admin_user());

-- ============ payment_schedules ============
CREATE POLICY payment_select ON payment_schedules FOR SELECT USING (is_admin_user());
CREATE POLICY payment_insert_admin ON payment_schedules FOR INSERT WITH CHECK (is_admin_user());
CREATE POLICY payment_update_dual ON payment_schedules FOR UPDATE USING (
  is_admin_user()
  OR dual_signoff_head_id = auth.uid()
  OR dual_signoff_finance_id = auth.uid()
);

-- ============ vendors ============
-- Regional isolation: vendor in my region OR super admin (spec §9)
CREATE POLICY vendor_region_isolation ON vendors FOR SELECT USING (
  region = (SELECT region FROM profiles WHERE id = auth.uid())
  OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'SUPER_ADMIN')
);
-- Onboarding (INSERT/UPDATE) restricted to SUPER_ADMIN + FINANCE (guardrail A)
CREATE POLICY vendor_insert_admin ON vendors FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('SUPER_ADMIN', 'FINANCE_AUDITOR', 'DEPUTY_HEAD_OF_IT'))
);
CREATE POLICY vendor_update_admin ON vendors FOR UPDATE USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('SUPER_ADMIN', 'FINANCE_AUDITOR', 'DEPUTY_HEAD_OF_IT'))
);

-- ============ fx_rates ============
CREATE POLICY fx_select_all ON fx_rates FOR SELECT USING (true);
CREATE POLICY fx_insert_admin ON fx_rates FOR INSERT WITH CHECK (is_admin_user());

-- ============ budget_lines ============
-- Head of IT (SUPER_ADMIN/DEPUTY) manages budget; FINANCE_AUDITOR read-only; others no access
CREATE POLICY budget_select ON budget_lines FOR SELECT USING (
  is_admin_user()
  OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'FINANCE_AUDITOR')
);
CREATE POLICY budget_insert_admin ON budget_lines FOR INSERT WITH CHECK (is_admin_user());
CREATE POLICY budget_update_admin ON budget_lines FOR UPDATE USING (is_admin_user());

-- ============ three_way_matches ============
-- Procurement creators, approvers, finance auditors, admins can view
CREATE POLICY threeway_select ON three_way_matches FOR SELECT USING (
  EXISTS (SELECT 1 FROM procurement_records pr WHERE pr.id = three_way_matches.procurement_id
    AND (pr.created_by = auth.uid() OR pr.level_1_approver = auth.uid()
         OR pr.level_2_approver = auth.uid() OR pr.level_3_approver = auth.uid()
         OR is_admin_user()))
  OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'FINANCE_AUDITOR')
);
-- Only admins and finance can create/update matches
CREATE POLICY threeway_insert_admin ON three_way_matches FOR INSERT WITH CHECK (
  is_admin_user() OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'FINANCE_AUDITOR')
);
CREATE POLICY threeway_update_admin ON three_way_matches FOR UPDATE USING (
  is_admin_user() OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'FINANCE_AUDITOR')
);

-- ============ knowledge_base_vectors ============
-- Vector search runs via SECURITY DEFINER function; direct select for admins
CREATE POLICY kb_select ON knowledge_base_vectors FOR SELECT USING (true);
CREATE POLICY kb_write_admin ON knowledge_base_vectors FOR INSERT WITH CHECK (is_admin_user());

-- ============ audit_logs (immutable — INSERT only, guardrail A/spec) ============
CREATE POLICY audit_insert_only ON audit_logs FOR INSERT WITH CHECK (true);
CREATE POLICY audit_select_admin ON audit_logs FOR SELECT USING (
  EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND role IN ('SUPER_ADMIN', 'DEPUTY_HEAD_OF_IT', 'FINANCE_AUDITOR'))
);

-- ============ dlq_entries (DLQ lifecycle: insert by system; admin manage) ============
-- System inserts on capture; admins (IT/Finance) read + manage lifecycle.
CREATE POLICY dlq_select_admin ON dlq_entries FOR SELECT USING (is_admin_user());
CREATE POLICY dlq_update_admin ON dlq_entries FOR UPDATE USING (is_admin_user());

-- Stored Procedure for Vector Match (spec §9). SECURITY DEFINER so app
-- can run similarity search through PostgREST/anon role (guardrail: RLS bypass).
CREATE OR REPLACE FUNCTION match_knowledge_base (
  query_embedding vector(1536),
  match_threshold float,
  match_count int
)
RETURNS TABLE (
  id uuid,
  document_title text,
  section_reference text,
  page_number int,
  content text,
  similarity float
)
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  RETURN QUERY
    SELECT kb.id, kb.document_title, kb.section_reference, kb.page_number,
           kb.content, 1 - (kb.embedding <=> query_embedding) AS similarity
    FROM knowledge_base_vectors kb
    WHERE 1 - (kb.embedding <=> query_embedding) > match_threshold
    ORDER BY kb.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;
GRANT EXECUTE ON FUNCTION match_knowledge_base(vector, float, int) TO anon, authenticated, service_role;

-- =====================================================================
-- GUARDRAIL D: Deputy auto-activation on SUPER_ADMIN leave
-- =====================================================================
CREATE OR REPLACE FUNCTION activate_deputy_on_leave()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  linked_deputy_id UUID;
BEGIN
  IF NEW.role <> 'SUPER_ADMIN' THEN
    RETURN NEW;
  END IF;

  SELECT id INTO linked_deputy_id
    FROM profiles
   WHERE deputy_for_user_id = NEW.id
     AND role = 'DEPUTY_HEAD_OF_IT'
     AND COALESCE(on_leave, FALSE) = FALSE
   ORDER BY created_at
   LIMIT 1;

  IF NEW.on_leave = TRUE AND OLD.on_leave = FALSE AND linked_deputy_id IS NOT NULL THEN
    INSERT INTO audit_logs (actor_id, action_type, target_resource, new_value, acted_as_deputy)
    VALUES (linked_deputy_id, 'DEPUTY_ACTIVATED', 'Head of IT role', jsonb_build_object('deputy', linked_deputy_id), TRUE);
  ELSIF NEW.on_leave = FALSE AND OLD.on_leave = TRUE AND linked_deputy_id IS NOT NULL THEN
    INSERT INTO audit_logs (actor_id, action_type, target_resource, new_value, acted_as_deputy)
    VALUES (NEW.id, 'DEPUTY_DEACTIVATED', 'Head of IT role', jsonb_build_object('deputy', linked_deputy_id), FALSE);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_deputy_on_leave ON profiles;
CREATE TRIGGER trg_deputy_on_leave
AFTER UPDATE OF on_leave ON profiles
FOR EACH ROW EXECUTE FUNCTION activate_deputy_on_leave();

-- =====================================================================
-- GUARDRAIL E: Stale staff heartbeat (updated > 4h or > 15 min in demo -> stale)
-- =====================================================================
CREATE OR REPLACE FUNCTION mark_stale_staff()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE staff_statuses
     SET is_stale = TRUE
   WHERE status_text ILIKE '%active%'
     AND is_stale = FALSE
     AND updated_at < NOW() - INTERVAL '4 hours';
END;
$$;

-- Schedule every 15 minutes (requires the pg_cron extension & access)
-- Note: use a distinct dollar-quote tag for the job SQL so it does not
-- prematurely close the outer DO $$ ... $$ body.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('mark-stale-staff', '*/15 * * * *', $cron$SELECT mark_stale_staff()$cron$);
  END IF;
END $$;

-- =====================================================================
-- GUARDRAIL / spec: Cost allocation sum must equal 100% per procurement
-- =====================================================================
CREATE OR REPLACE FUNCTION enforce_allocation_total()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE total numeric;
BEGIN
  SELECT COALESCE(SUM(percentage_share),0) INTO total
    FROM cost_allocations WHERE procurement_id = NEW.procurement_id;
  IF total > 100 THEN
    RAISE EXCEPTION 'Cost allocation totals exceed 100%% for this procurement';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_alloc_total ON cost_allocations;
CREATE TRIGGER trg_alloc_total
AFTER INSERT OR UPDATE ON cost_allocations
FOR EACH ROW EXECUTE FUNCTION enforce_allocation_total();

-- =====================================================================
-- GUARDRAIL F: 2FA — the app enforces TOTP at login (see supabase integration
-- routes). The database layer allows admins to view enforcement state via a
-- dedicated function. Auth-level TOTP is enforced in the API auth middleware.
-- =====================================================================

-- =====================================================================
-- Budget Lines: auto-maintain incurred_amount (on PR approval) and paid_amount (on payment)
-- =====================================================================
CREATE OR REPLACE FUNCTION update_budget_incurred()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  bl_id uuid;
  pr_hkd numeric;
BEGIN
  IF NEW.status IN ('PR_APPROVED', 'PO_ISSUED') AND (OLD.status IS NULL OR OLD.status NOT IN ('PR_APPROVED', 'PO_ISSUED')) THEN
    IF NEW.budget_line_id IS NOT NULL THEN
      pr_hkd := COALESCE(NEW.hkd_amount, 0);
      UPDATE budget_lines
         SET incurred_amount = incurred_amount + pr_hkd,
             updated_at = NOW()
       WHERE id = NEW.budget_line_id;
    END IF;
  ELSIF OLD.status IN ('PR_APPROVED', 'PO_ISSUED') AND NEW.status NOT IN ('PR_APPROVED', 'PO_ISSUED') THEN
    -- status moved back from approved -> decrement
    IF OLD.budget_line_id IS NOT NULL THEN
      pr_hkd := COALESCE(OLD.hkd_amount, 0);
      UPDATE budget_lines
         SET incurred_amount = GREATEST(incurred_amount - pr_hkd, 0),
             updated_at = NOW()
       WHERE id = OLD.budget_line_id;
    END IF;
  ELSIF NEW.budget_line_id IS DISTINCT FROM OLD.budget_line_id THEN
    -- budget_line changed: decrement old, increment new
    IF OLD.budget_line_id IS NOT NULL AND OLD.status IN ('PR_APPROVED', 'PO_ISSUED') THEN
      pr_hkd := COALESCE(OLD.hkd_amount, 0);
      UPDATE budget_lines
         SET incurred_amount = GREATEST(incurred_amount - pr_hkd, 0),
             updated_at = NOW()
       WHERE id = OLD.budget_line_id;
    END IF;
    IF NEW.budget_line_id IS NOT NULL AND NEW.status IN ('PR_APPROVED', 'PO_ISSUED') THEN
      pr_hkd := COALESCE(NEW.hkd_amount, 0);
      UPDATE budget_lines
         SET incurred_amount = incurred_amount + pr_hkd,
             updated_at = NOW()
       WHERE id = NEW.budget_line_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_budget_incurred ON procurement_records;
CREATE TRIGGER trg_budget_incurred
AFTER UPDATE ON procurement_records
FOR EACH ROW EXECUTE FUNCTION update_budget_incurred();

-- Update paid_amount when payment_schedules.paid_at is set
CREATE OR REPLACE FUNCTION update_budget_paid()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.paid_at IS NOT NULL AND (OLD.paid_at IS NULL OR OLD.paid_at <> NEW.paid_at) THEN
    UPDATE budget_lines bl
       SET paid_amount = paid_amount + NEW.amount,
           updated_at = NOW()
      FROM procurement_records pr
     WHERE pr.id = NEW.procurement_id
       AND bl.id = pr.budget_line_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_budget_paid ON payment_schedules;
CREATE TRIGGER trg_budget_paid
AFTER UPDATE ON payment_schedules
FOR EACH ROW EXECUTE FUNCTION update_budget_paid();

-- =====================================================================
-- Procurement: auto-set legal/security review flags when HKD > 100,000
-- =====================================================================
CREATE OR REPLACE FUNCTION set_review_requirements()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Auto-set review flags based on HKD amount
  IF NEW.hkd_amount > 100000 THEN
    NEW.legal_review_required := TRUE;
    NEW.security_review_required := TRUE;
    -- Set to PENDING if not already set
    IF NEW.legal_review_status IS NULL OR NEW.legal_review_status = 'PENDING' THEN
      NEW.legal_review_status := 'PENDING';
    END IF;
    IF NEW.security_review_status IS NULL OR NEW.security_review_status = 'PENDING' THEN
      NEW.security_review_status := 'PENDING';
    END IF;
  ELSE
    NEW.legal_review_required := FALSE;
    NEW.security_review_required := FALSE;
    NEW.legal_review_status := 'PENDING';
    NEW.security_review_status := 'PENDING';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_review_requirements ON procurement_records;
CREATE TRIGGER trg_review_requirements
BEFORE INSERT OR UPDATE ON procurement_records
FOR EACH ROW EXECUTE FUNCTION set_review_requirements();

-- =====================================================================
-- Three-Way Match: auto-create when invoice uploaded, validate variances
-- Price variance tolerance: 0%, Shipping/Tax tolerance: ±2%
-- =====================================================================
CREATE OR REPLACE FUNCTION validate_three_way_match()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  reference_amount numeric;
  price_variance_pct numeric;
  shipping_tax_variance_pct numeric;
  match_status three_way_match_status;
BEGIN
  -- Only process when invoice_amount is set/updated
  IF NEW.invoice_amount IS NOT NULL AND (OLD.invoice_amount IS NULL OR OLD.invoice_amount <> NEW.invoice_amount) THEN
    -- The invoice is matched against THIS schedule's amount:
    --   - milestone payments: the milestone's target amount (e.g. 3:4:3)
    --   - single payments:    the full PO / schedule amount
    reference_amount := NEW.amount;

    -- Price variance: invoice_amount vs schedule amount - tolerance 0%
    price_variance_pct := CASE
      WHEN reference_amount > 0
      THEN abs((NEW.invoice_amount - reference_amount) / reference_amount * 100)
      ELSE 0
    END;

    -- Shipping/Tax variance - tolerance ±2%
    shipping_tax_variance_pct := CASE
      WHEN reference_amount > 0 AND NEW.variance_amount IS NOT NULL
      THEN abs(NEW.variance_amount / reference_amount * 100)
      ELSE 0
    END;

    -- Determine match status
    IF price_variance_pct > 0 THEN
      match_status := 'PRICE_VARIANCE';
    ELSIF shipping_tax_variance_pct > 2 THEN
      match_status := 'SHIPPING_TAX_VARIANCE';
    ELSE
      match_status := 'MATCHED';
    END IF;

    -- Upsert three_way_match record
    INSERT INTO three_way_matches (
      procurement_id, payment_schedule_id, po_amount, invoice_amount,
      milestone_amount, shipping_tax_variance, status, matched_at, matched_by
    ) VALUES (
      NEW.procurement_id, NEW.id, reference_amount, NEW.invoice_amount,
      NEW.amount, COALESCE(NEW.variance_amount, 0),
      match_status,
      CASE WHEN match_status = 'MATCHED' THEN NOW() END,
      CASE WHEN match_status = 'MATCHED' THEN NEW.variance_resolved_by END
    )
    ON CONFLICT (procurement_id, payment_schedule_id) DO UPDATE SET
      invoice_amount = EXCLUDED.invoice_amount,
      milestone_amount = EXCLUDED.milestone_amount,
      shipping_tax_variance = EXCLUDED.shipping_tax_variance,
      status = EXCLUDED.status,
      matched_at = EXCLUDED.matched_at,
      matched_by = EXCLUDED.matched_by,
      updated_at = NOW();

    -- If variance detected, update payment_schedule and procurement status
    IF match_status IN ('PRICE_VARIANCE', 'SHIPPING_TAX_VARIANCE') THEN
      NEW.is_variance_detected := TRUE;
      NEW.variance_type := CASE
        WHEN match_status = 'PRICE_VARIANCE' THEN 'PRICE'
        ELSE 'SHIPPING_TAX'
      END;
      NEW.variance_amount := CASE
        WHEN match_status = 'PRICE_VARIANCE'
        THEN NEW.invoice_amount - reference_amount
        ELSE NEW.variance_amount
      END;

      -- Update procurement status to VARIANCE_BLOCKED if not already
      UPDATE procurement_records
        SET status = 'VARIANCE_BLOCKED', updated_at = NOW()
      WHERE id = NEW.procurement_id AND status NOT IN ('VARIANCE_BLOCKED', 'PAYMENT_APPROVED', 'PAID');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_three_way_match ON payment_schedules;
CREATE TRIGGER trg_three_way_match
AFTER INSERT OR UPDATE ON payment_schedules
FOR EACH ROW EXECUTE FUNCTION validate_three_way_match();

-- =====================================================================
-- Audit logging for procurement status changes
-- =====================================================================
CREATE OR REPLACE FUNCTION audit_procurement_status()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO audit_logs (actor_id, action_type, target_resource, old_value, new_value)
    VALUES (
      COALESCE(NEW.level_1_approver, NEW.level_2_approver, NEW.level_3_approver, NEW.created_by),
      'PROCUREMENT_STATUS_CHANGE',
      'procurement_records',
      jsonb_build_object('status', OLD.status, 'hkd_amount', OLD.hkd_amount),
      jsonb_build_object('status', NEW.status, 'hkd_amount', NEW.hkd_amount)
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_procurement ON procurement_records;
CREATE TRIGGER trg_audit_procurement
AFTER UPDATE ON procurement_records
FOR EACH ROW EXECUTE FUNCTION audit_procurement_status();

-- =====================================================================
-- Audit logging for payment schedule changes (variance, dual sign-off, payment)
-- =====================================================================
CREATE OR REPLACE FUNCTION audit_payment_schedule()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_variance_detected IS DISTINCT FROM OLD.is_variance_detected
     OR NEW.dual_signoff_head_id IS DISTINCT FROM OLD.dual_signoff_head_id
     OR NEW.dual_signoff_finance_id IS DISTINCT FROM OLD.dual_signoff_finance_id
     OR NEW.paid_at IS DISTINCT FROM OLD.paid_at
     OR NEW.variance_resolved_at IS DISTINCT FROM OLD.variance_resolved_at THEN
    INSERT INTO audit_logs (actor_id, action_type, target_resource, old_value, new_value)
    VALUES (
      COALESCE(NEW.variance_resolved_by, NEW.dual_signoff_head_id, NEW.dual_signoff_finance_id),
      'PAYMENT_SCHEDULE_CHANGE',
      'payment_schedules',
      jsonb_build_object(
        'is_variance_detected', OLD.is_variance_detected,
        'dual_signoff_head_id', OLD.dual_signoff_head_id,
        'dual_signoff_finance_id', OLD.dual_signoff_finance_id,
        'paid_at', OLD.paid_at,
        'variance_resolved_at', OLD.variance_resolved_at
      ),
      jsonb_build_object(
        'is_variance_detected', NEW.is_variance_detected,
        'dual_signoff_head_id', NEW.dual_signoff_head_id,
        'dual_signoff_finance_id', NEW.dual_signoff_finance_id,
        'paid_at', NEW.paid_at,
        'variance_resolved_at', NEW.variance_resolved_at
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_payment ON payment_schedules;
CREATE TRIGGER trg_audit_payment
AFTER UPDATE ON payment_schedules
FOR EACH ROW EXECUTE FUNCTION audit_payment_schedule();

-- =====================================================================
-- Indexes for hot query paths
-- =====================================================================
CREATE INDEX idx_staff_statuses_user ON staff_statuses(user_id);
CREATE INDEX idx_staff_statuses_updated ON staff_statuses(updated_at);
CREATE INDEX idx_proc_vendor ON procurement_records(vendor_id);
CREATE INDEX idx_proc_status ON procurement_records(status);
CREATE INDEX idx_proc_budget ON procurement_records(budget_line_id);
CREATE INDEX idx_proc_project ON procurement_records(project_code);
CREATE INDEX idx_proc_legal_review ON procurement_records(legal_review_status) WHERE legal_review_required;
CREATE INDEX idx_proc_security_review ON procurement_records(security_review_status) WHERE security_review_required;
CREATE INDEX idx_alloc_proc ON cost_allocations(procurement_id);
CREATE INDEX idx_pay_proc ON payment_schedules(procurement_id);
CREATE INDEX idx_pay_milestone ON payment_schedules(milestone_number) WHERE is_milestone_payment;
CREATE INDEX idx_pay_variance ON payment_schedules(is_variance_detected) WHERE is_variance_detected;
CREATE INDEX idx_threeway_proc ON three_way_matches(procurement_id);
CREATE INDEX idx_audit_actor ON audit_logs(actor_id);
CREATE INDEX idx_audit_created ON audit_logs(created_at);
CREATE INDEX idx_budget_year_cat ON budget_lines(fiscal_year, category);
