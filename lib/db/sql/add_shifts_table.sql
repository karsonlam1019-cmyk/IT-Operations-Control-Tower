-- Jira shift sync table.
-- Run this once in the Supabase SQL Editor for an existing project.
-- The service-role key used by the sync bypasses RLS for the upsert.

CREATE TABLE IF NOT EXISTS public.shifts (
    id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    jira_issue_key text NOT NULL UNIQUE,
    staff_member text NOT NULL DEFAULT 'Unassigned',
    team text,
    region text,
    environment text,
    signal text NOT NULL DEFAULT 'Unknown',
    action text,
    due_date date,
    jira_updated_at timestamp with time zone,
    last_synced_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shifts_jira_updated_idx
    ON public.shifts (jira_updated_at);

ALTER TABLE public.shifts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shifts_select_authenticated ON public.shifts;
CREATE POLICY shifts_select_authenticated ON public.shifts
    FOR SELECT TO authenticated
    USING (true);

GRANT SELECT ON TABLE public.shifts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.shifts TO service_role;

NOTIFY pgrst, 'reload schema';