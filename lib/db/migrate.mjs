#!/usr/bin/env node
/*
 * One-off DB migration for the IT Operations Control Tower.
 *
 * Applies lib/db/sql/schema.sql then lib/db/sql/seed.sql to the live
 * PostgreSQL database using the statement-splitter (works under the Supabase
 * pooler / pgbouncer which reject multi-statement single queries).
 *
 * The connection string must come from the DATABASE_URL env var (already
 * loaded by the workspace) or be passed as argv[2]. Secrets are NEVER
 * hardcoded here.
 *
 * Usage:
 *   node migrate.mjs                # use process.env.DATABASE_URL
 *   node migrate.mjs "<DATABASE_URL>"
 *   node migrate.mjs --forward      # safely apply ordered ALTER migrations
 *   node migrate.mjs --reset        # drop & recreate the public schema first
 *
 * This is a deliberate one-off command. It is intentionally NOT wired into
 * application startup or post-merge, so a deploy never re-runs migrations
 * against a live database (see scripts/post-merge.sh).
 */
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(path) {
  try {
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) process.env[m[1]] = m[2].trim();
    }
  } catch {
    /* no .env, rely on process env */
  }
}

// Resolve repo-root .env for local runs (mirrors api-server/src/index.ts).
const candidates = [
  resolve(".env"),
  resolve(here, "..", "..", ".env"),
  resolve(here, "..", "..", "..", ".env"),
];
for (const c of candidates) loadEnvFile(c);

const args = process.argv.slice(2);
const doReset = args.includes("--reset");
const doForward = args.includes("--forward");
const argUrl = args.find((a) => a.startsWith("postgres") || a.startsWith("postgresql"));

let url = process.env.DATABASE_URL;
if (argUrl) url = argUrl;
if (!url) {
  console.error("DATABASE_URL is required (set it or pass it as argv[2]).");
  process.exit(2);
}

const { default: pg } = await import("pg");
const { Client } = pg;

function splitStatements(sql) {
  const statements = [];
  let cur = "";
  let i = 0;
  const n = sql.length;
  const flush = () => { const s = cur.trim(); if (s) statements.push(s); cur = ""; };
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "-" && next === "-") { let j = i + 2; while (j < n && sql[j] !== "\n") j++; cur += sql.slice(i, j + 1); i = j + 1; continue; }
    if (ch === "/" && next === "*") { let j = sql.indexOf("*/", i + 2); j = j === -1 ? n : j + 2; cur += sql.slice(i, j); i = j; continue; }
    if (ch === "'") { let j = i + 1; while (j < n) { if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue; } j++; break; } j++; } cur += sql.slice(i, j); i = j; continue; }
    if (ch === '"') { let j = i + 1; while (j < n && sql[j] !== '"') j++; j = Math.min(j + 1, n); cur += sql.slice(i, j); i = j; continue; }
    if (ch === "$" && next === "$") { let j = i + 2; const end = sql.indexOf("$$", j); const close = end === -1 ? n : end + 2; cur += sql.slice(i, close); i = close; continue; }
    if (ch === ";") { cur += ";"; flush(); i++; continue; }
    cur += ch; i++;
  }
  flush();
  return statements;
}

async function run(client, label, stmts) {
  for (let idx = 0; idx < stmts.length; idx++) {
    try {
      const t0 = Date.now();
      await client.query(stmts[idx]);
      console.log(`[OK] ${label} ${idx + 1}/${stmts.length} (${Date.now() - t0}ms)`);
    } catch (e) {
      console.error(`\n[FAIL] ${label} stmt ${idx + 1}/${stmts.length}:`);
      console.error("  code:", e.code);
      console.error("  msg :", e.message.split("\n")[0]);
      throw e;
    }
  }
}

const client = new Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20000,
});
await client.connect();
console.log("Connected.\n");

if (doForward) {
  const migrationFiles = [
    "001_vendor_portal_milestone_confirmation.sql",
    "002_deputy_delegation_audit.sql",
  ];
  for (const file of migrationFiles) {
    const raw = await readFile(join(here, "sql", "migrations", file), "utf8");
    await run(client, `MIGRATION ${file}`, splitStatements(raw));
  }
  console.log("\nALL DONE: forward migrations applied.");
  await client.end().catch(() => {});
  process.exit(0);
}

if (doReset) {
  console.log("--- RESET public schema (--reset) ---");
  await client.query("DROP SCHEMA IF EXISTS public CASCADE;");
  await client.query("CREATE SCHEMA public;");
  await client.query("GRANT USAGE, CREATE ON SCHEMA public TO anon, authenticated, service_role;");
  await client.query("GRANT ALL ON SCHEMA public TO postgres;");
  const explicitDrop = `
    DROP TRIGGER IF EXISTS trg_deputy_on_leave ON profiles;
    DROP TRIGGER IF EXISTS trg_alloc_total ON cost_allocations;
    DROP TABLE IF EXISTS audit_logs CASCADE;
    DROP TABLE IF EXISTS knowledge_base_vectors CASCADE;
    DROP TABLE IF EXISTS payment_schedules CASCADE;
    DROP TABLE IF EXISTS cost_allocations CASCADE;
    DROP TABLE IF EXISTS procurement_records CASCADE;
    DROP TABLE IF EXISTS vendors CASCADE;
    DROP TABLE IF EXISTS staff_statuses CASCADE;
    DROP TABLE IF EXISTS fx_rates CASCADE;
    DROP TABLE IF EXISTS profiles CASCADE;
    DROP TABLE IF EXISTS teams CASCADE;
    DROP TYPE IF EXISTS region_code CASCADE;
    DROP TYPE IF EXISTS env_type CASCADE;
    DROP TYPE IF EXISTS pr_po_status CASCADE;
    DROP TYPE IF EXISTS user_role CASCADE;
    DROP TYPE IF EXISTS budget_category CASCADE;
    DROP TYPE IF EXISTS review_status CASCADE;
    DROP TYPE IF EXISTS three_way_match_status CASCADE;
  `;
  for (const s of explicitDrop.split(";").map((x) => x.trim()).filter(Boolean)) {
    try { await client.query(s + ";"); } catch (e) { console.log("  (skip) " + s.slice(0, 40) + " -> " + e.code); }
  }
  console.log("public schema recreated + objects dropped + regranted.\n");
}

const schemaRaw = await readFile(join(here, "sql", "schema.sql"), "utf8");
const seedRaw = await readFile(join(here, "sql", "seed.sql"), "utf8");
const schemaStmts = splitStatements(schemaRaw);
const seedStmts = splitStatements(seedRaw);
console.log(`schema.sql -> ${schemaStmts.length} statements`);
console.log(`seed.sql   -> ${seedStmts.length} statements\n`);

console.log("--- APPLY SCHEMA ---");
await run(client, "SCHEMA", schemaStmts);
console.log("SCHEMA applied.\n");

console.log("--- APPLY SEED ----");
await run(client, "SEED", seedStmts);
console.log("SEED applied.\n");

console.log("ALL DONE: schema + seed applied.");
await client.end().catch(() => {});
