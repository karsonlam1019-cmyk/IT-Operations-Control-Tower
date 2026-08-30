# IT Operations Control Tower

Enterprise command center for staff operations, release governance, procurement approvals, treasury allocation, compliance guidance, and immutable audit activity.

## Run & Operate

- Replit workflow `API Server` — runs `PORT=8080 pnpm --filter @workspace/api-server run dev`
- Replit workflow `IT Operations Control Tower` — runs `PORT=21727 BASE_PATH=/ pnpm --filter @workspace/it-operations-control-tower run dev`
- `pnpm --filter @workspace/api-server run dev` — run the API server locally with `PORT=8080`
- `PORT=21727 BASE_PATH=/ pnpm --filter @workspace/it-operations-control-tower run dev` — run the dashboard locally
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
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
- Start app services through their managed workflows so `PORT` and `BASE_PATH` are provided.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
