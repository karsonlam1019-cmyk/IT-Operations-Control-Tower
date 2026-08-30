-- =====================================================================
-- IT Operations Control Tower - Supabase clone (exported from LIVE DB)
-- Generated via pg_dump from the production project on <DATE>.
--
-- APPLY:  psql "<NEW_PROJECT_DATABASE_URL>" -f clone_supabase.sql
-- The web SQL Editor cannot run "COPY ... FROM stdin", so use psql.
-- After restoring, recreate the matching auth.users accounts (see below).
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

SET statement_timeout = 0;
--
-- PostgreSQL database dump
--

\restrict UtF4veXgp0q5kISb6dmIWwZMHR7ylq76J0syZfaY04d3OahSlCONFGJIhQErLKq

-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.6 (Ubuntu 18.6-0ubuntu0.26.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- CREATE SCHEMA public; (already exists on Supabase)


--
-- Name: budget_category; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.budget_category AS ENUM (
    'HARDWARE',
    'SOFTWARE',
    'DATA',
    'SERVICES'
);


--
-- Name: env_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.env_type AS ENUM (
    'SIT',
    'UAT',
    'STAGING',
    'PROD'
);


--
-- Name: pr_po_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.pr_po_status AS ENUM (
    'PR_DRAFT',
    'PR_APPROVED',
    'PO_ISSUED',
    'MILESTONE_RECEIVED',
    'INVOICE_PENDING',
    'VARIANCE_BLOCKED',
    'PAYMENT_APPROVED',
    'PAID'
);


--
-- Name: region_code; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.region_code AS ENUM (
    'HK',
    'CN',
    'MY',
    'ID'
);


--
-- Name: review_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.review_status AS ENUM (
    'PENDING',
    'APPROVED',
    'REJECTED'
);


--
-- Name: three_way_match_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.three_way_match_status AS ENUM (
    'PENDING',
    'MATCHED',
    'PRICE_VARIANCE',
    'SHIPPING_TAX_VARIANCE',
    'BLOCKED'
);


--
-- Name: user_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_role AS ENUM (
    'SUPER_ADMIN',
    'DEPUTY_HEAD_OF_IT',
    'TEAM_LEAD',
    'IT_COLLEAGUE',
    'FINANCE_AUDITOR',
    'VENDOR_API'
);


--
-- Name: activate_deputy_on_leave(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.activate_deputy_on_leave() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.on_leave = TRUE AND OLD.on_leave = FALSE THEN
    -- mark the linked deputy as a delegated authority holder
    UPDATE profiles
       SET role = 'DEPUTY_HEAD_OF_IT'
     WHERE id = NEW.deputy_for_user_id;
    INSERT INTO audit_logs (actor_id, action_type, target_resource, new_value, acted_as_deputy)
    VALUES (NEW.id, 'DEPUTY_ACTIVATED', 'profiles', jsonb_build_object('deputy', NEW.deputy_for_user_id), NEW.deputy_for_user_id IS NOT NULL);
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: audit_payment_schedule(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_payment_schedule() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: audit_procurement_status(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_procurement_status() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: current_vendor_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_vendor_id() RETURNS uuid
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    RETURN NULLIF(current_setting('app.vendor_id', true), '')::uuid;
EXCEPTION WHEN others THEN
    RETURN NULL;
END;
$$;


--
-- Name: enforce_allocation_total(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_allocation_total() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: is_admin_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_admin_user() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('SUPER_ADMIN', 'DEPUTY_HEAD_OF_IT', 'FINANCE_AUDITOR')
  );
$$;


--
-- Name: mark_stale_staff(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_stale_staff() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE staff_statuses
     SET is_stale = TRUE
   WHERE status_text ILIKE '%active%'
     AND is_stale = FALSE
     AND updated_at < NOW() - INTERVAL '4 hours';
END;
$$;


--
-- Name: match_knowledge_base(public.vector, double precision, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_knowledge_base(query_embedding public.vector, match_threshold double precision, match_count integer) RETURNS TABLE(id uuid, document_title text, section_reference text, page_number integer, content text, similarity double precision)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
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


--
-- Name: set_review_requirements(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_review_requirements() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: update_budget_incurred(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_budget_incurred() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: update_budget_paid(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_budget_paid() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: validate_three_way_match(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_three_way_match() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    actor_id uuid,
    action_type text NOT NULL,
    target_resource text NOT NULL,
    old_value jsonb,
    new_value jsonb,
    acted_as_deputy boolean DEFAULT false,
    ip_address text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: budget_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.budget_lines (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    fiscal_year integer NOT NULL,
    category public.budget_category NOT NULL,
    description text,
    allocated_amount numeric(15,2) DEFAULT 0 NOT NULL,
    incurred_amount numeric(15,2) DEFAULT 0 NOT NULL,
    paid_amount numeric(15,2) DEFAULT 0 NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: cost_allocations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cost_allocations (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    procurement_id uuid,
    business_unit text NOT NULL,
    percentage_share numeric(5,2) NOT NULL,
    CONSTRAINT cost_allocations_percentage_share_check CHECK (((percentage_share > (0)::numeric) AND (percentage_share <= (100)::numeric)))
);


--
-- Name: deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deliveries (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    procurement_id uuid NOT NULL,
    payment_schedule_id uuid,
    vendor_id uuid NOT NULL,
    delivered_at timestamp with time zone,
    qty numeric(15,2),
    notes text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: dlq_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dlq_entries (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    status text DEFAULT 'PENDING'::text NOT NULL,
    payload jsonb NOT NULL,
    error_code text,
    error_message text,
    retry_count integer DEFAULT 0 NOT NULL,
    max_retries integer DEFAULT 5 NOT NULL,
    next_attempt_at timestamp with time zone,
    last_error_at timestamp with time zone,
    resolved_by uuid,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: fx_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fx_rates (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    base_currency character varying(3) DEFAULT 'HKD'::character varying NOT NULL,
    quote_currency character varying(3) NOT NULL,
    rate numeric(18,6) NOT NULL,
    effective_at timestamp with time zone DEFAULT now()
);


--
-- Name: knowledge_base_vectors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge_base_vectors (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    document_title text NOT NULL,
    language character varying(2) NOT NULL,
    section_reference text,
    page_number integer,
    content text NOT NULL,
    embedding public.vector(1536),
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: payment_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_schedules (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    procurement_id uuid,
    due_date date NOT NULL,
    amount numeric(15,2) NOT NULL,
    milestone_number integer,
    milestone_description text,
    is_milestone_payment boolean DEFAULT false,
    ocr_invoice_data jsonb,
    invoice_amount numeric(15,2),
    invoice_date date,
    invoice_number text,
    is_variance_detected boolean DEFAULT false,
    variance_type text,
    variance_amount numeric(15,2),
    variance_resolution_notes text,
    variance_resolved_by uuid,
    variance_resolved_at timestamp with time zone,
    dual_signoff_head_id uuid,
    dual_signoff_finance_id uuid,
    dual_signoff_at timestamp with time zone,
    paid_at timestamp with time zone,
    paid_amount numeric(15,2),
    payment_reference text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: procurement_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.procurement_records (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    pr_number text NOT NULL,
    po_number text,
    project_code text NOT NULL,
    vendor_id uuid NOT NULL,
    budget_line_id uuid,
    region public.region_code NOT NULL,
    local_currency character varying(3) NOT NULL,
    local_amount numeric(15,2) NOT NULL,
    hkd_amount numeric(15,2) NOT NULL,
    fx_rate numeric(18,6) NOT NULL,
    payment_terms text,
    expected_settlement_amount numeric(15,2),
    expected_settlement_month text,
    terms text,
    delivery_address text,
    tax_id text,
    status public.pr_po_status DEFAULT 'PR_DRAFT'::public.pr_po_status,
    legal_review_required boolean DEFAULT false,
    security_review_required boolean DEFAULT false,
    legal_review_status public.review_status DEFAULT 'PENDING'::public.review_status,
    security_review_status public.review_status DEFAULT 'PENDING'::public.review_status,
    legal_review_by uuid,
    security_review_by uuid,
    legal_review_at timestamp with time zone,
    security_review_at timestamp with time zone,
    created_by uuid,
    level_1_approver uuid,
    level_2_approver uuid,
    level_3_approver uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    po_accepted_at timestamp with time zone,
    po_acceptance_notes text
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    full_name text NOT NULL,
    role public.user_role DEFAULT 'IT_COLLEAGUE'::public.user_role NOT NULL,
    team_id uuid,
    region public.region_code DEFAULT 'HK'::public.region_code NOT NULL,
    deputy_for_user_id uuid,
    on_leave boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: staff_statuses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_statuses (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    status_text text NOT NULL,
    active_ticket_id text,
    environment public.env_type DEFAULT 'SIT'::public.env_type,
    eta_completion timestamp with time zone,
    is_stale boolean DEFAULT false,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: teams; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teams (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    team_name text NOT NULL,
    team_lead_id uuid,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: three_way_matches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.three_way_matches (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    procurement_id uuid NOT NULL,
    payment_schedule_id uuid,
    po_amount numeric(15,2) NOT NULL,
    invoice_amount numeric(15,2),
    milestone_amount numeric(15,2),
    price_variance numeric(15,2) GENERATED ALWAYS AS ((COALESCE(invoice_amount, (0)::numeric) - po_amount)) STORED,
    shipping_tax_variance numeric(15,2),
    status public.three_way_match_status DEFAULT 'PENDING'::public.three_way_match_status,
    matched_at timestamp with time zone,
    matched_by uuid,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: vendors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendors (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    vendor_name text NOT NULL,
    region public.region_code NOT NULL,
    contact text,
    delivery_address text,
    payment_terms text,
    tax_id text,
    api_key_hash text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Data for Name: audit_logs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.audit_logs (id, actor_id, action_type, target_resource, old_value, new_value, acted_as_deputy, ip_address, created_at) FROM stdin;
76adfa15-c955-4d2e-8ba9-b92e763add36	7937447c-090e-4248-885b-0798763e5994	LOGIN	auth	\N	{"provider": "email"}	f	\N	2026-08-30 02:59:43.583532+00
325166b5-c311-43c7-84ad-9753848a08b9	7937447c-090e-4248-885b-0798763e5994	PROCUREMENT_CREATED	procurement_records	\N	{"pr": "PR-2026-0001"}	f	\N	2026-08-30 02:59:43.583532+00
2cec5aef-a9ee-4308-82fc-e6fc53f42841	57198c98-3a7b-4e16-b072-5c4c9dd31ffe	PROCUREMENT_STATUS_CHANGE	procurement_records	{"status": "PO_ISSUED", "hkd_amount": 700000.00}	{"status": "MILESTONE_RECEIVED", "hkd_amount": 700000.00}	f	\N	2026-08-30 13:30:45.571823+00
\.


--
-- Data for Name: budget_lines; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.budget_lines (id, fiscal_year, category, description, allocated_amount, incurred_amount, paid_amount, created_by, created_at, updated_at) FROM stdin;
40000000-0000-0000-0000-000000000002	2026	SOFTWARE	SaaS licences / subscriptions	3000000.00	0.00	0.00	7937447c-090e-4248-885b-0798763e5994	2026-08-30 02:59:43.21238+00	2026-08-30 02:59:43.21238+00
40000000-0000-0000-0000-000000000003	2026	DATA	Data platform / analytics	2000000.00	0.00	0.00	7937447c-090e-4248-885b-0798763e5994	2026-08-30 02:59:43.21238+00	2026-08-30 02:59:43.21238+00
40000000-0000-0000-0000-000000000004	2026	SERVICES	Professional services / support	1500000.00	0.00	0.00	7937447c-090e-4248-885b-0798763e5994	2026-08-30 02:59:43.21238+00	2026-08-30 02:59:43.21238+00
40000000-0000-0000-0000-000000000001	2026	HARDWARE	Server/Storage/Network refresh	5000000.00	0.00	0.00	7937447c-090e-4248-885b-0798763e5994	2026-08-30 02:59:43.21238+00	2026-08-30 13:30:45.571823+00
\.


--
-- Data for Name: cost_allocations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.cost_allocations (id, procurement_id, business_unit, percentage_share) FROM stdin;
73a17f51-9c82-4fb1-bc4b-61651440485a	30000000-0000-0000-0000-000000000001	Enterprise Platform	40.00
38c1a7ac-231f-499c-abf3-2026c1a80842	30000000-0000-0000-0000-000000000001	Regional Operations	35.00
5e8ef149-dec2-4ee3-a66e-d4b9a43cf187	30000000-0000-0000-0000-000000000001	Cloud Enablement	25.00
d780c3a3-1fd1-47ad-adf3-77e16191b7d5	30000000-0000-0000-0000-000000000002	Network Services	100.00
bb604815-817a-4a04-b8ba-40307ebc257e	30000000-0000-0000-0000-000000000003	Hardware Refresh	60.00
c87c125f-d17d-44ec-8dd8-b8d9c733816a	30000000-0000-0000-0000-000000000003	End-User Computing	40.00
\.


--
-- Data for Name: deliveries; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.deliveries (id, procurement_id, payment_schedule_id, vendor_id, delivered_at, qty, notes, created_at) FROM stdin;
f3c6107a-2d5f-4034-aac2-9f4e4f9bec92	30000000-0000-0000-0000-000000000001	c3de43a5-e281-4d26-b1be-c2bf45bc8c4c	20000000-0000-0000-0000-000000000001	2026-08-30 00:00:00+00	\N	\N	2026-08-30 13:30:45.460211+00
\.


--
-- Data for Name: dlq_entries; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.dlq_entries (id, status, payload, error_code, error_message, retry_count, max_retries, next_attempt_at, last_error_at, resolved_by, resolved_at, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: fx_rates; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.fx_rates (id, base_currency, quote_currency, rate, effective_at) FROM stdin;
e653a0fd-6ad9-42e7-949a-6caa8e8ec0f6	HKD	MYR	0.599900	2026-08-30 02:59:43.523359+00
9d8dee95-8ed5-49df-bb1c-eef8845dbdab	HKD	CNY	0.925000	2026-08-30 02:59:43.523359+00
e9330009-a1ab-418a-80e6-c68552e626e3	HKD	IDR	4900.000000	2026-08-30 02:59:43.523359+00
5ef3cd1d-f947-46c5-a9d7-feb5785d3aa9	HKD	SGD	0.172000	2026-08-30 02:59:43.523359+00
5d2c590e-d927-4a56-b80e-3a9dc864e8c2	HKD	USD	0.127800	2026-08-30 02:59:43.523359+00
\.


--
-- Data for Name: knowledge_base_vectors; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.knowledge_base_vectors (id, document_title, language, section_reference, page_number, content, embedding, created_at) FROM stdin;
\.


--
-- Data for Name: payment_schedules; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.payment_schedules (id, procurement_id, due_date, amount, milestone_number, milestone_description, is_milestone_payment, ocr_invoice_data, invoice_amount, invoice_date, invoice_number, is_variance_detected, variance_type, variance_amount, variance_resolution_notes, variance_resolved_by, variance_resolved_at, dual_signoff_head_id, dual_signoff_finance_id, dual_signoff_at, paid_at, paid_amount, payment_reference, created_at, updated_at) FROM stdin;
844cc184-6d0b-4381-95b1-0bd739655f4d	30000000-0000-0000-0000-000000000001	2026-09-15	280000.00	1	Design & procurement complete	t	\N	280000.00	2026-09-10	INV-2026-001	f	\N	\N	\N	\N	\N	7937447c-090e-4248-885b-0798763e5994	0ebb310c-b241-48b0-9254-7b78f7634676	\N	2026-09-15 00:00:00+00	280000.00	PAY-2026-001	2026-08-30 02:59:43.399629+00	2026-08-30 02:59:43.399629+00
c3de43a5-e281-4d26-b1be-c2bf45bc8c4c	30000000-0000-0000-0000-000000000001	2026-12-15	420000.00	2	Delivery & UAT sign-off	t	\N	420000.00	2026-12-10	INV-2026-002	f	\N	\N	\N	\N	\N	7937447c-090e-4248-885b-0798763e5994	0ebb310c-b241-48b0-9254-7b78f7634676	\N	\N	\N	\N	2026-08-30 02:59:43.399629+00	2026-08-30 02:59:43.399629+00
738e26a4-634d-43d1-a15b-788706c18611	30000000-0000-0000-0000-000000000002	2026-08-30	185000.00	\N	\N	f	\N	185000.00	2026-08-25	INV-2026-003	f	\N	\N	\N	\N	\N	\N	\N	\N	2026-08-30 00:00:00+00	185000.00	PAY-2026-003	2026-08-30 02:59:43.399629+00	2026-08-30 02:59:43.399629+00
f176c26f-2ef6-4d04-aae3-d70ea06c45aa	30000000-0000-0000-0000-000000000003	2026-09-01	2000000.00	\N	\N	f	\N	2100000.00	2026-08-28	INV-2026-004	t	PRICE	100000.00	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-08-30 02:59:43.399629+00	2026-08-30 02:59:43.399629+00
\.


--
-- Data for Name: procurement_records; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.procurement_records (id, pr_number, po_number, project_code, vendor_id, budget_line_id, region, local_currency, local_amount, hkd_amount, fx_rate, payment_terms, expected_settlement_amount, expected_settlement_month, terms, delivery_address, tax_id, status, legal_review_required, security_review_required, legal_review_status, security_review_status, legal_review_by, security_review_by, legal_review_at, security_review_at, created_by, level_1_approver, level_2_approver, level_3_approver, created_at, updated_at, po_accepted_at, po_acceptance_notes) FROM stdin;
30000000-0000-0000-0000-000000000002	PR-2026-0002	PO-2026-0102	PROJ-IT-2026-002	20000000-0000-0000-0000-000000000002	40000000-0000-0000-0000-000000000002	HK	HKD	185000.00	185000.00	1.000000	NET 60	185000.00	2026-09-01	Network equipment upgrade	\N	\N	PR_APPROVED	t	t	PENDING	PENDING	\N	\N	\N	\N	7937447c-090e-4248-885b-0798763e5994	57198c98-3a7b-4e16-b072-5c4c9dd31ffe	\N	\N	2026-08-30 02:59:43.273426+00	2026-08-30 02:59:43.273426+00	\N	\N
30000000-0000-0000-0000-000000000003	PR-2026-0003	\N	PROJ-IT-2026-003	20000000-0000-0000-0000-000000000004	40000000-0000-0000-0000-000000000001	ID	IDR	9800000000.00	2000000.00	0.000204	NET 30	2000000.00	2026-10-01	Storage hardware procurement	\N	\N	VARIANCE_BLOCKED	t	t	PENDING	PENDING	\N	\N	\N	\N	7937447c-090e-4248-885b-0798763e5994	57198c98-3a7b-4e16-b072-5c4c9dd31ffe	0ebb310c-b241-48b0-9254-7b78f7634676	\N	2026-08-30 02:59:43.273426+00	2026-08-30 02:59:43.273426+00	\N	\N
30000000-0000-0000-0000-000000000001	PR-2026-0001	PO-2026-0101	PROJ-IT-2026-001	20000000-0000-0000-0000-000000000001	40000000-0000-0000-0000-000000000001	MY	MYR	420000.00	700000.00	1.666700	MILESTONE 3:4:3	700000.00	2026-12-01	Hardware refresh for regional data centers	\N	\N	MILESTONE_RECEIVED	t	t	PENDING	PENDING	\N	\N	\N	\N	7937447c-090e-4248-885b-0798763e5994	57198c98-3a7b-4e16-b072-5c4c9dd31ffe	0ebb310c-b241-48b0-9254-7b78f7634676	\N	2026-08-30 02:59:43.273426+00	2026-08-30 13:30:45.571823+00	\N	\N
\.


--
-- Data for Name: profiles; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.profiles (id, full_name, role, team_id, region, deputy_for_user_id, on_leave, created_at) FROM stdin;
7937447c-090e-4248-885b-0798763e5994	Leah Chan	SUPER_ADMIN	10000000-0000-0000-0000-000000000001	HK	\N	f	2026-08-30 02:59:42.795551+00
11b50e41-88e6-4297-bdba-6c76caf641ec	Marcus Wong	DEPUTY_HEAD_OF_IT	10000000-0000-0000-0000-000000000001	HK	7937447c-090e-4248-885b-0798763e5994	f	2026-08-30 02:59:42.795551+00
57198c98-3a7b-4e16-b072-5c4c9dd31ffe	Priya Nair	TEAM_LEAD	10000000-0000-0000-0000-000000000002	HK	\N	f	2026-08-30 02:59:42.795551+00
4866e1a2-aed7-4112-b9fe-bab59549aeb6	Tom Cheng	TEAM_LEAD	10000000-0000-0000-0000-000000000003	HK	\N	f	2026-08-30 02:59:42.795551+00
0f4090eb-f2ee-4882-a439-6c16fb9ddeb6	Aisha Rahman	TEAM_LEAD	10000000-0000-0000-0000-000000000004	MY	\N	f	2026-08-30 02:59:42.795551+00
2d1a01a5-ec91-4e25-be93-d2a91003b743	Wei Lin	TEAM_LEAD	10000000-0000-0000-0000-000000000005	CN	\N	f	2026-08-30 02:59:42.795551+00
0ebb310c-b241-48b0-9254-7b78f7634676	Siti Halim	FINANCE_AUDITOR	\N	MY	\N	f	2026-08-30 02:59:42.795551+00
a531a015-8ad9-4a6e-b877-4606aef3d753	Ravi Menon	IT_COLLEAGUE	10000000-0000-0000-0000-000000000001	HK	\N	f	2026-08-30 02:59:42.795551+00
cf6eb3c5-55c0-4e10-8332-344ec72c188f	Grace Lim	IT_COLLEAGUE	10000000-0000-0000-0000-000000000002	HK	\N	f	2026-08-30 02:59:42.795551+00
dcc4575a-6f3a-4d08-a51c-efceac401d55	Daniel Ho	IT_COLLEAGUE	10000000-0000-0000-0000-000000000003	HK	\N	f	2026-08-30 02:59:42.795551+00
246b7f07-8baa-406a-a7d3-817a979d2f23	Nina Tan	IT_COLLEAGUE	10000000-0000-0000-0000-000000000004	MY	\N	f	2026-08-30 02:59:42.795551+00
bbb71b84-fd22-4f2c-ad96-2aa752300f4f	Kenji Sato	IT_COLLEAGUE	10000000-0000-0000-0000-000000000005	ID	\N	f	2026-08-30 02:59:42.795551+00
\.


--
-- Data for Name: staff_statuses; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.staff_statuses (id, user_id, status_text, active_ticket_id, environment, eta_completion, is_stale, updated_at) FROM stdin;
\.


--
-- Data for Name: teams; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.teams (id, team_name, team_lead_id, created_at) FROM stdin;
10000000-0000-0000-0000-000000000006	DevOps & Platform	\N	2026-08-30 02:59:42.73351+00
10000000-0000-0000-0000-000000000007	End-User Computing	\N	2026-08-30 02:59:42.73351+00
10000000-0000-0000-0000-000000000008	Enterprise Architecture	\N	2026-08-30 02:59:42.73351+00
10000000-0000-0000-0000-000000000001	Infrastructure & Cloud	7937447c-090e-4248-885b-0798763e5994	2026-08-30 02:59:42.73351+00
10000000-0000-0000-0000-000000000002	Network & Security	57198c98-3a7b-4e16-b072-5c4c9dd31ffe	2026-08-30 02:59:42.73351+00
10000000-0000-0000-0000-000000000003	Service Desk	4866e1a2-aed7-4112-b9fe-bab59549aeb6	2026-08-30 02:59:42.73351+00
10000000-0000-0000-0000-000000000004	Application Delivery	0f4090eb-f2ee-4882-a439-6c16fb9ddeb6	2026-08-30 02:59:42.73351+00
10000000-0000-0000-0000-000000000005	Data & Analytics	2d1a01a5-ec91-4e25-be93-d2a91003b743	2026-08-30 02:59:42.73351+00
\.


--
-- Data for Name: three_way_matches; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.three_way_matches (id, procurement_id, payment_schedule_id, po_amount, invoice_amount, milestone_amount, shipping_tax_variance, status, matched_at, matched_by, notes, created_at, updated_at) FROM stdin;
652dc516-2b64-4b01-91ad-f84636a9c97a	30000000-0000-0000-0000-000000000001	844cc184-6d0b-4381-95b1-0bd739655f4d	280000.00	280000.00	280000.00	0.00	MATCHED	2026-08-30 02:59:43.399629+00	\N	\N	2026-08-30 02:59:43.399629+00	2026-08-30 02:59:43.399629+00
0a793af8-a7f5-498b-b00b-9b830f58bd92	30000000-0000-0000-0000-000000000001	c3de43a5-e281-4d26-b1be-c2bf45bc8c4c	420000.00	420000.00	420000.00	0.00	MATCHED	2026-08-30 02:59:43.399629+00	\N	\N	2026-08-30 02:59:43.399629+00	2026-08-30 02:59:43.399629+00
35770b26-fbef-4ea8-bcb5-f45d09cac8aa	30000000-0000-0000-0000-000000000002	738e26a4-634d-43d1-a15b-788706c18611	185000.00	185000.00	185000.00	0.00	MATCHED	2026-08-30 02:59:43.399629+00	\N	\N	2026-08-30 02:59:43.399629+00	2026-08-30 02:59:43.399629+00
4b2a1f31-c46c-4189-9da8-51e238581a52	30000000-0000-0000-0000-000000000003	f176c26f-2ef6-4d04-aae3-d70ea06c45aa	2000000.00	2100000.00	2000000.00	100000.00	PRICE_VARIANCE	\N	\N	\N	2026-08-30 02:59:43.399629+00	2026-08-30 02:59:43.399629+00
\.


--
-- Data for Name: vendors; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.vendors (id, vendor_name, region, contact, delivery_address, payment_terms, tax_id, api_key_hash, created_by, created_at) FROM stdin;
20000000-0000-0000-0000-000000000001	Cerebrum Cloud Pte Ltd	MY	ops@cerebrum.io	\N	NET 30	MY-998877	3a8932b16da76043cb2bccfeaca5f8a399bf2cc38f7638585fbee76dde5cbcc7	\N	2026-08-30 02:59:43.153479+00
20000000-0000-0000-0000-000000000002	NexaNet HK Limited	HK	billing@nexanet.hk	\N	NET 15	HK-12345678	f76c939be2ed5918cf4ef200c2cf99a80a3a2e085961c20f7b7c079d765293f0	\N	2026-08-30 02:59:43.153479+00
20000000-0000-0000-0000-000000000003	Greenline Data Services	CN	sales@greenline.cn	\N	NET 60	CN-445566	4cf38e9b9e57b6623aac1e72369dc9bbe82a5620eec2094be674545b1b836a37	\N	2026-08-30 02:59:43.153479+00
20000000-0000-0000-0000-000000000004	Meridian Hardware Distrib	ID	ap@meridian-hardware.co.id	\N	NET 30	ID-778899	0844854c8472b129969c7688a9d0738c819c872cdbae4711e3f7e296b33d5dc2	\N	2026-08-30 02:59:43.153479+00
20000000-0000-0000-0000-000000000005	Skybridge Security Pte Ltd	MY	contact@skybridge.my	\N	NET 45	MY-112233	f5b03d309b65f944e34bfab0c365983ed4db1f2dcc7d651762347b8b7a583f28	\N	2026-08-30 02:59:43.153479+00
20000000-0000-0000-0000-000000000006	PacificWorks Telecom	HK	finance@pacificworks.hk	\N	NET 15	HK-87654321	becf73967f83568246e48d12fac6eb8a85e64cf9f11965581f52619027b48ac9	\N	2026-08-30 02:59:43.153479+00
\.


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: budget_lines budget_lines_fiscal_year_category_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_lines
    ADD CONSTRAINT budget_lines_fiscal_year_category_key UNIQUE (fiscal_year, category);


--
-- Name: budget_lines budget_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_lines
    ADD CONSTRAINT budget_lines_pkey PRIMARY KEY (id);


--
-- Name: cost_allocations cost_allocations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_allocations
    ADD CONSTRAINT cost_allocations_pkey PRIMARY KEY (id);


--
-- Name: deliveries deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_pkey PRIMARY KEY (id);


--
-- Name: deliveries deliveries_procurement_id_payment_schedule_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_procurement_id_payment_schedule_id_key UNIQUE (procurement_id, payment_schedule_id);


--
-- Name: dlq_entries dlq_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dlq_entries
    ADD CONSTRAINT dlq_entries_pkey PRIMARY KEY (id);


--
-- Name: fx_rates fx_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fx_rates
    ADD CONSTRAINT fx_rates_pkey PRIMARY KEY (id);


--
-- Name: knowledge_base_vectors knowledge_base_vectors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_base_vectors
    ADD CONSTRAINT knowledge_base_vectors_pkey PRIMARY KEY (id);


--
-- Name: payment_schedules payment_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_schedules
    ADD CONSTRAINT payment_schedules_pkey PRIMARY KEY (id);


--
-- Name: procurement_records procurement_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procurement_records
    ADD CONSTRAINT procurement_records_pkey PRIMARY KEY (id);


--
-- Name: procurement_records procurement_records_po_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procurement_records
    ADD CONSTRAINT procurement_records_po_number_key UNIQUE (po_number);


--
-- Name: procurement_records procurement_records_pr_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procurement_records
    ADD CONSTRAINT procurement_records_pr_number_key UNIQUE (pr_number);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: staff_statuses staff_statuses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_statuses
    ADD CONSTRAINT staff_statuses_pkey PRIMARY KEY (id);


--
-- Name: staff_statuses staff_statuses_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_statuses
    ADD CONSTRAINT staff_statuses_user_id_key UNIQUE (user_id);


--
-- Name: teams teams_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_pkey PRIMARY KEY (id);


--
-- Name: three_way_matches three_way_matches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.three_way_matches
    ADD CONSTRAINT three_way_matches_pkey PRIMARY KEY (id);


--
-- Name: three_way_matches three_way_matches_procurement_id_payment_schedule_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.three_way_matches
    ADD CONSTRAINT three_way_matches_procurement_id_payment_schedule_id_key UNIQUE (procurement_id, payment_schedule_id);


--
-- Name: vendors vendors_api_key_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendors
    ADD CONSTRAINT vendors_api_key_hash_key UNIQUE (api_key_hash);


--
-- Name: vendors vendors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendors
    ADD CONSTRAINT vendors_pkey PRIMARY KEY (id);


--
-- Name: idx_alloc_proc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alloc_proc ON public.cost_allocations USING btree (procurement_id);


--
-- Name: idx_audit_actor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_actor ON public.audit_logs USING btree (actor_id);


--
-- Name: idx_audit_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_created ON public.audit_logs USING btree (created_at);


--
-- Name: idx_budget_year_cat; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_budget_year_cat ON public.budget_lines USING btree (fiscal_year, category);


--
-- Name: idx_dlq_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dlq_created ON public.dlq_entries USING btree (created_at);


--
-- Name: idx_dlq_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dlq_status ON public.dlq_entries USING btree (status);


--
-- Name: idx_pay_milestone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pay_milestone ON public.payment_schedules USING btree (milestone_number) WHERE is_milestone_payment;


--
-- Name: idx_pay_proc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pay_proc ON public.payment_schedules USING btree (procurement_id);


--
-- Name: idx_pay_variance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pay_variance ON public.payment_schedules USING btree (is_variance_detected) WHERE is_variance_detected;


--
-- Name: idx_proc_budget; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proc_budget ON public.procurement_records USING btree (budget_line_id);


--
-- Name: idx_proc_legal_review; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proc_legal_review ON public.procurement_records USING btree (legal_review_status) WHERE legal_review_required;


--
-- Name: idx_proc_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proc_project ON public.procurement_records USING btree (project_code);


--
-- Name: idx_proc_security_review; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proc_security_review ON public.procurement_records USING btree (security_review_status) WHERE security_review_required;


--
-- Name: idx_proc_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proc_status ON public.procurement_records USING btree (status);


--
-- Name: idx_proc_vendor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proc_vendor ON public.procurement_records USING btree (vendor_id);


--
-- Name: idx_staff_statuses_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_statuses_updated ON public.staff_statuses USING btree (updated_at);


--
-- Name: idx_staff_statuses_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_statuses_user ON public.staff_statuses USING btree (user_id);


--
-- Name: idx_threeway_proc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_threeway_proc ON public.three_way_matches USING btree (procurement_id);


--
-- Name: cost_allocations trg_alloc_total; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_alloc_total AFTER INSERT OR UPDATE ON public.cost_allocations FOR EACH ROW EXECUTE FUNCTION public.enforce_allocation_total();


--
-- Name: payment_schedules trg_audit_payment; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_payment AFTER UPDATE ON public.payment_schedules FOR EACH ROW EXECUTE FUNCTION public.audit_payment_schedule();


--
-- Name: procurement_records trg_audit_procurement; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_procurement AFTER UPDATE ON public.procurement_records FOR EACH ROW EXECUTE FUNCTION public.audit_procurement_status();


--
-- Name: procurement_records trg_budget_incurred; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_budget_incurred AFTER UPDATE ON public.procurement_records FOR EACH ROW EXECUTE FUNCTION public.update_budget_incurred();


--
-- Name: payment_schedules trg_budget_paid; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_budget_paid AFTER UPDATE ON public.payment_schedules FOR EACH ROW EXECUTE FUNCTION public.update_budget_paid();


--
-- Name: profiles trg_deputy_on_leave; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_deputy_on_leave AFTER UPDATE OF on_leave ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.activate_deputy_on_leave();


--
-- Name: procurement_records trg_review_requirements; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_review_requirements BEFORE INSERT OR UPDATE ON public.procurement_records FOR EACH ROW EXECUTE FUNCTION public.set_review_requirements();


--
-- Name: payment_schedules trg_three_way_match; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_three_way_match AFTER INSERT OR UPDATE ON public.payment_schedules FOR EACH ROW EXECUTE FUNCTION public.validate_three_way_match();


--
-- Name: audit_logs audit_logs_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.profiles(id);


--
-- Name: budget_lines budget_lines_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_lines
    ADD CONSTRAINT budget_lines_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id);


--
-- Name: cost_allocations cost_allocations_procurement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_allocations
    ADD CONSTRAINT cost_allocations_procurement_id_fkey FOREIGN KEY (procurement_id) REFERENCES public.procurement_records(id) ON DELETE CASCADE;


--
-- Name: deliveries deliveries_payment_schedule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_payment_schedule_id_fkey FOREIGN KEY (payment_schedule_id) REFERENCES public.payment_schedules(id) ON DELETE SET NULL;


--
-- Name: deliveries deliveries_procurement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_procurement_id_fkey FOREIGN KEY (procurement_id) REFERENCES public.procurement_records(id) ON DELETE CASCADE;


--
-- Name: deliveries deliveries_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id);


--
-- Name: dlq_entries dlq_entries_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dlq_entries
    ADD CONSTRAINT dlq_entries_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.profiles(id);


--
-- Name: payment_schedules payment_schedules_dual_signoff_finance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_schedules
    ADD CONSTRAINT payment_schedules_dual_signoff_finance_id_fkey FOREIGN KEY (dual_signoff_finance_id) REFERENCES public.profiles(id);


--
-- Name: payment_schedules payment_schedules_dual_signoff_head_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_schedules
    ADD CONSTRAINT payment_schedules_dual_signoff_head_id_fkey FOREIGN KEY (dual_signoff_head_id) REFERENCES public.profiles(id);


--
-- Name: payment_schedules payment_schedules_procurement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_schedules
    ADD CONSTRAINT payment_schedules_procurement_id_fkey FOREIGN KEY (procurement_id) REFERENCES public.procurement_records(id) ON DELETE CASCADE;


--
-- Name: payment_schedules payment_schedules_variance_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_schedules
    ADD CONSTRAINT payment_schedules_variance_resolved_by_fkey FOREIGN KEY (variance_resolved_by) REFERENCES public.profiles(id);


--
-- Name: procurement_records procurement_records_budget_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procurement_records
    ADD CONSTRAINT procurement_records_budget_line_id_fkey FOREIGN KEY (budget_line_id) REFERENCES public.budget_lines(id);


--
-- Name: procurement_records procurement_records_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procurement_records
    ADD CONSTRAINT procurement_records_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id);


--
-- Name: procurement_records procurement_records_legal_review_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procurement_records
    ADD CONSTRAINT procurement_records_legal_review_by_fkey FOREIGN KEY (legal_review_by) REFERENCES public.profiles(id);


--
-- Name: procurement_records procurement_records_level_1_approver_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procurement_records
    ADD CONSTRAINT procurement_records_level_1_approver_fkey FOREIGN KEY (level_1_approver) REFERENCES public.profiles(id);


--
-- Name: procurement_records procurement_records_level_2_approver_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procurement_records
    ADD CONSTRAINT procurement_records_level_2_approver_fkey FOREIGN KEY (level_2_approver) REFERENCES public.profiles(id);


--
-- Name: procurement_records procurement_records_level_3_approver_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procurement_records
    ADD CONSTRAINT procurement_records_level_3_approver_fkey FOREIGN KEY (level_3_approver) REFERENCES public.profiles(id);


--
-- Name: procurement_records procurement_records_security_review_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procurement_records
    ADD CONSTRAINT procurement_records_security_review_by_fkey FOREIGN KEY (security_review_by) REFERENCES public.profiles(id);


--
-- Name: procurement_records procurement_records_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procurement_records
    ADD CONSTRAINT procurement_records_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id);


--
-- Name: profiles profiles_deputy_for_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_deputy_for_user_id_fkey FOREIGN KEY (deputy_for_user_id) REFERENCES public.profiles(id);


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id);


--
-- Name: staff_statuses staff_statuses_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_statuses
    ADD CONSTRAINT staff_statuses_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: teams teams_team_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_team_lead_id_fkey FOREIGN KEY (team_lead_id) REFERENCES public.profiles(id);


--
-- Name: three_way_matches three_way_matches_matched_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.three_way_matches
    ADD CONSTRAINT three_way_matches_matched_by_fkey FOREIGN KEY (matched_by) REFERENCES public.profiles(id);


--
-- Name: three_way_matches three_way_matches_payment_schedule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.three_way_matches
    ADD CONSTRAINT three_way_matches_payment_schedule_id_fkey FOREIGN KEY (payment_schedule_id) REFERENCES public.payment_schedules(id) ON DELETE SET NULL;


--
-- Name: three_way_matches three_way_matches_procurement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.three_way_matches
    ADD CONSTRAINT three_way_matches_procurement_id_fkey FOREIGN KEY (procurement_id) REFERENCES public.procurement_records(id) ON DELETE CASCADE;


--
-- Name: vendors vendors_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendors
    ADD CONSTRAINT vendors_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id);


--
-- Name: cost_allocations alloc_insert_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY alloc_insert_admin ON public.cost_allocations FOR INSERT WITH CHECK (public.is_admin_user());


--
-- Name: cost_allocations alloc_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY alloc_select ON public.cost_allocations FOR SELECT USING (public.is_admin_user());


--
-- Name: cost_allocations alloc_update_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY alloc_update_admin ON public.cost_allocations FOR UPDATE USING (public.is_admin_user());


--
-- Name: audit_logs audit_insert_only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY audit_insert_only ON public.audit_logs FOR INSERT WITH CHECK (true);


--
-- Name: audit_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_logs audit_select_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY audit_select_admin ON public.audit_logs FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['SUPER_ADMIN'::public.user_role, 'DEPUTY_HEAD_OF_IT'::public.user_role, 'FINANCE_AUDITOR'::public.user_role]))))));


--
-- Name: budget_lines budget_insert_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY budget_insert_admin ON public.budget_lines FOR INSERT WITH CHECK (public.is_admin_user());


--
-- Name: budget_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.budget_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: budget_lines budget_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY budget_select ON public.budget_lines FOR SELECT USING ((public.is_admin_user() OR (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'FINANCE_AUDITOR'::public.user_role))))));


--
-- Name: budget_lines budget_update_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY budget_update_admin ON public.budget_lines FOR UPDATE USING (public.is_admin_user());


--
-- Name: cost_allocations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cost_allocations ENABLE ROW LEVEL SECURITY;

--
-- Name: deliveries delivery_vendor_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delivery_vendor_all ON public.deliveries USING (((public.current_vendor_id() IS NOT NULL) AND (vendor_id = public.current_vendor_id())));


--
-- Name: dlq_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dlq_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: dlq_entries dlq_select_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY dlq_select_admin ON public.dlq_entries FOR SELECT USING (public.is_admin_user());


--
-- Name: dlq_entries dlq_update_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY dlq_update_admin ON public.dlq_entries FOR UPDATE USING (public.is_admin_user());


--
-- Name: fx_rates fx_insert_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY fx_insert_admin ON public.fx_rates FOR INSERT WITH CHECK (public.is_admin_user());


--
-- Name: fx_rates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.fx_rates ENABLE ROW LEVEL SECURITY;

--
-- Name: fx_rates fx_select_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY fx_select_all ON public.fx_rates FOR SELECT USING (true);


--
-- Name: knowledge_base_vectors kb_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kb_select ON public.knowledge_base_vectors FOR SELECT USING (true);


--
-- Name: knowledge_base_vectors kb_write_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kb_write_admin ON public.knowledge_base_vectors FOR INSERT WITH CHECK (public.is_admin_user());


--
-- Name: knowledge_base_vectors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.knowledge_base_vectors ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_schedules payment_insert_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payment_insert_admin ON public.payment_schedules FOR INSERT WITH CHECK (public.is_admin_user());


--
-- Name: payment_schedules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_schedules ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_schedules payment_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payment_select ON public.payment_schedules FOR SELECT USING (public.is_admin_user());


--
-- Name: payment_schedules payment_update_dual; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payment_update_dual ON public.payment_schedules FOR UPDATE USING ((public.is_admin_user() OR (dual_signoff_head_id = auth.uid()) OR (dual_signoff_finance_id = auth.uid())));


--
-- Name: payment_schedules payment_vendor_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payment_vendor_read ON public.payment_schedules FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.procurement_records pr
  WHERE ((pr.id = payment_schedules.procurement_id) AND (pr.vendor_id = public.current_vendor_id())))));


--
-- Name: procurement_records procurement_insert_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY procurement_insert_admin ON public.procurement_records FOR INSERT WITH CHECK ((public.is_admin_user() OR (created_by = auth.uid())));


--
-- Name: procurement_records; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.procurement_records ENABLE ROW LEVEL SECURITY;

--
-- Name: procurement_records procurement_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY procurement_select ON public.procurement_records FOR SELECT USING (((created_by = auth.uid()) OR (level_1_approver = auth.uid()) OR (level_2_approver = auth.uid()) OR (level_3_approver = auth.uid()) OR public.is_admin_user()));


--
-- Name: procurement_records procurement_update_approver; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY procurement_update_approver ON public.procurement_records FOR UPDATE USING ((public.is_admin_user() OR (level_1_approver = auth.uid()) OR (level_2_approver = auth.uid()) OR (level_3_approver = auth.uid())));


--
-- Name: procurement_records procurement_vendor_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY procurement_vendor_read ON public.procurement_records FOR SELECT USING (((public.current_vendor_id() IS NOT NULL) AND (vendor_id = public.current_vendor_id())));


--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles profiles_insert_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_insert_admin ON public.profiles FOR INSERT WITH CHECK (public.is_admin_user());


--
-- Name: profiles profiles_select_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_select_self ON public.profiles FOR SELECT USING (((id = auth.uid()) OR public.is_admin_user()));


--
-- Name: profiles profiles_update_admin_role; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_update_admin_role ON public.profiles FOR UPDATE USING (public.is_admin_user());


--
-- Name: profiles profiles_update_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_update_self ON public.profiles FOR UPDATE USING ((id = auth.uid())) WITH CHECK ((id = auth.uid()));


--
-- Name: staff_statuses staff_select_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY staff_select_self ON public.staff_statuses FOR SELECT USING (((user_id = auth.uid()) OR public.is_admin_user() OR (auth.uid() IN ( SELECT teams.team_lead_id
   FROM public.teams
  WHERE (teams.team_lead_id IS NOT NULL)))));


--
-- Name: staff_statuses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.staff_statuses ENABLE ROW LEVEL SECURITY;

--
-- Name: staff_statuses staff_write_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY staff_write_admin ON public.staff_statuses FOR UPDATE USING (public.is_admin_user());


--
-- Name: staff_statuses staff_write_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY staff_write_self ON public.staff_statuses USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: teams; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;

--
-- Name: teams teams_select_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY teams_select_member ON public.teams FOR SELECT USING (true);


--
-- Name: teams teams_update_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY teams_update_admin ON public.teams FOR UPDATE USING (public.is_admin_user());


--
-- Name: teams teams_write_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY teams_write_admin ON public.teams FOR INSERT WITH CHECK (public.is_admin_user());


--
-- Name: three_way_matches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.three_way_matches ENABLE ROW LEVEL SECURITY;

--
-- Name: three_way_matches threeway_insert_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY threeway_insert_admin ON public.three_way_matches FOR INSERT WITH CHECK ((public.is_admin_user() OR (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'FINANCE_AUDITOR'::public.user_role))))));


--
-- Name: three_way_matches threeway_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY threeway_select ON public.three_way_matches FOR SELECT USING (((EXISTS ( SELECT 1
   FROM public.procurement_records pr
  WHERE ((pr.id = three_way_matches.procurement_id) AND ((pr.created_by = auth.uid()) OR (pr.level_1_approver = auth.uid()) OR (pr.level_2_approver = auth.uid()) OR (pr.level_3_approver = auth.uid()) OR public.is_admin_user())))) OR (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'FINANCE_AUDITOR'::public.user_role))))));


--
-- Name: three_way_matches threeway_update_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY threeway_update_admin ON public.three_way_matches FOR UPDATE USING ((public.is_admin_user() OR (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'FINANCE_AUDITOR'::public.user_role))))));


--
-- Name: three_way_matches threeway_vendor_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY threeway_vendor_read ON public.three_way_matches FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.procurement_records pr
  WHERE ((pr.id = three_way_matches.procurement_id) AND (pr.vendor_id = public.current_vendor_id())))));


--
-- Name: vendors vendor_insert_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vendor_insert_admin ON public.vendors FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['SUPER_ADMIN'::public.user_role, 'FINANCE_AUDITOR'::public.user_role, 'DEPUTY_HEAD_OF_IT'::public.user_role]))))));


--
-- Name: vendors vendor_region_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vendor_region_isolation ON public.vendors FOR SELECT USING (((region = ( SELECT profiles.region
   FROM public.profiles
  WHERE (profiles.id = auth.uid()))) OR (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'SUPER_ADMIN'::public.user_role))))));


--
-- Name: vendors vendor_self_portal; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vendor_self_portal ON public.vendors FOR SELECT USING (((public.current_vendor_id() IS NOT NULL) AND (id = public.current_vendor_id())));


--
-- Name: vendors vendor_update_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vendor_update_admin ON public.vendors FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['SUPER_ADMIN'::public.user_role, 'FINANCE_AUDITOR'::public.user_role, 'DEPUTY_HEAD_OF_IT'::public.user_role]))))));


--
-- Name: vendors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vendors ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

\unrestrict UtF4veXgp0q5kISb6dmIWwZMHR7ylq76J0syZfaY04d3OahSlCONFGJIhQErLKq

