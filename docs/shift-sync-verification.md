# Jira SHIFT ↔ Supabase shift verification

`@workspace/scripts` includes a read-only reconciliation check for the live Jira
project `SHIFT` and the Supabase table `public.shifts`. It does not create,
update, or delete issues or rows, and it is not exposed through the dashboard
or browser.

## Required configuration

The command requires:

- `JIRA_BASE_URL`
- `JIRA_EMAIL`
- `JIRA_API_TOKEN`
- `SUPABASE_J_URL` and `SUPABASE_J_SERVICE_ROLE_KEY` (the verifier also accepts
  the existing `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` names)

The Jira credentials are checked first. The Supabase OpenAPI schema is then
inspected to confirm that `public.shifts` exists and to resolve exact live
columns. The verifier uses the supplied mapping:

| Jira field | Supabase column |
| --- | --- |
| Issue key | `jira_issue_key` |
| Staff Member | `staff_member` |
| Team01 | `team` |
| Region | `region` |
| Environment | `environment` |
| Signal | `signal` |
| Status | `action` |
| Status_Ticket | `Process_Status` |
| Jira updated timestamp | `jira_updated_at` |

`last_synced_at` is also required for the write command. The verifier stops
with a schema/mapping error instead of guessing when any mapped column or Jira
custom field is absent or ambiguous. The current mapping does not define
shift start/end times, so the check reports Jira update timestamp drift but
does not claim to validate shift duration.

## Run

From the repository root:

```sh
pnpm --filter @workspace/scripts check-shifts
```

The output is an operator-safe summary containing source counts, duplicate and
missing identifier counts, one-sided rows, malformed records, field and
timestamp mismatches, and stale-update counts. It never prints credentials,
connection strings, response bodies, or individual source records.

Exit status is zero for a consistent feed or for two reachable empty sources
(`EMPTY_REACHABLE`). It is non-zero for a reconciliation mismatch, missing or
ambiguous schema mapping, malformed provider response, authentication failure,
or connectivity failure.

The comparison and normalization logic can be run without live credentials:

```sh
pnpm --filter @workspace/scripts test
pnpm --filter @workspace/scripts typecheck
```

To perform an explicit one-time upsert from Jira into Supabase:

```sh
pnpm --filter @workspace/scripts sync-shifts
```

The sync only inserts or updates rows keyed by `jira_issue_key`; it never
deletes Supabase-only rows. It validates all Jira records before writing and
re-reads the table afterward to report the resulting reconciliation.