#!/usr/bin/env node
/*
 * Apply schema.sql + seed.sql to a new Supabase Postgres, or apply ordered
 * forward migrations to an existing database with --forward.
 * Usage: node apply-supabase.mjs <DATABASE_URL> [--forward]
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const url = process.argv[2];
const doForward = process.argv.includes('--forward');
if (!url) {
  console.error('Usage: node apply-supabase.mjs <DATABASE_URL>');
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const schema = await readFile(join(here, 'sql', 'schema.sql'), 'utf8');
const seed = await readFile(join(here, 'sql', 'seed.sql'), 'utf8');
const forwardMigrations = [
  '001_vendor_portal_milestone_confirmation.sql',
  '002_deputy_delegation_audit.sql',
];

const { default: pg } = await import('pg');
const { Client } = pg;

const client = new Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20000,
});

async function run(label, sql) {
  const t0 = Date.now();
  const res = await client.query(sql);
  console.log(`[OK] ${label} (${Date.now() - t0}ms) commandCount=${res.command?.length ?? '?'}`);
  return res;
}

try {
  await client.connect();
  console.log('Connected.');
  if (doForward) {
    for (const file of forwardMigrations) {
      const migration = await readFile(join(here, 'sql', 'migrations', file), 'utf8');
      await run(`MIGRATION ${file}`, migration);
    }
  } else {
    await run('SCHEMA (CREATE TABLE/RLS/triggers)', schema);
    await run('SEED (teams/profiles/vendors/financials)', seed);
  }
  console.log('\nALL DONE');
} catch (e) {
  console.error('\nFAILED:', e.code || '', e.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
