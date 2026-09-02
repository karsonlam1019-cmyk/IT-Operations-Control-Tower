# IT Operations Control Tower

Enterprise command center for staff operations, release governance, procurement approvals, treasury allocation, compliance guidance, and immutable audit activity.

## Run & Operate

- Dashboard preview (canonical): managed workflow `artifacts/it-operations-control-tower: web` runs `pnpm --filter @workspace/it-operations-control-tower run dev` on port `21727`, mounted at `/`.
- API service: managed workflow `artifacts/api-server: API Server` runs `pnpm --filter @workspace/api-server run dev` on port `8080`, mounted at `/api`.
- The dashboard's same-origin `/api/*` requests are proxied to `http://127.0.0.1:8080` in both Vite development and standalone production preview; the production artifact router also maps `/api` to the API service.
- Production dashboard builds to `artifacts/it-operations-control-tower/dist/public` and uses the artifact's static server with an SPA rewrite for every client route.
- Restart the two managed workflows above rather than creating a root `Start application` workflow or selecting the legacy port `5000`; the artifact configuration is the source of truth for preview routing and ports.
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm run smoke:dashboard` — start both artifact-owned services on isolated ports, verify API health and dashboard HTML, and confirm clean process shutdown
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/db run migrate:forward` — apply ordered, idempotent migrations to an existing database
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 20, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/it-operations-control-tower/src/App.tsx` — dashboard routes and interaction surfaces
- `artifacts/it-operations-control-tower/src/index.css` — product theme and responsive styling
- `artifacts/api-server/src/routes/operations.ts` — operations API and representative data
- `lib/api-spec/openapi.yaml` — source of truth for dashboard API contracts

## Architecture decisions

- The first build uses representative API-backed data so every workflow is usable before production integrations are connected.
- Generated OpenAPI hooks are the frontend boundary; keep contract changes in `lib/api-spec/openapi.yaml` and regenerate before use.
- DeepSeek, Jira, Supabase, 2FA, and vendor API connectivity remain production integration work; do not expose provider credentials in the browser.

## Product

The app provides a cross-domain command center, staff shift board, environment release checklist, PR/PO approval workflow, treasury analytics, cited compliance search, and access/audit controls.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Run API codegen after every OpenAPI change.
- Start app services through their managed workflows so `PORT` and `BASE_PATH` are provided (`21727`/`/` for the dashboard, `8080`/`/api` for the API).
- Apply `migrate:forward` before deploying API code that reads newly added database columns.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
