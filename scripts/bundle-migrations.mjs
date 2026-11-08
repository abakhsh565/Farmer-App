#!/usr/bin/env node
/**
 * Bundles the migration chain into one file that can be pasted into the Supabase
 * SQL editor and run once.
 *
 * This exists because of a real constraint rather than for tidiness: the machine
 * this project is being built on has no working container runtime, so there is no
 * local Postgres, and no `supabase` CLI either. The dashboard SQL editor is then
 * the only way to apply the schema — and applying seventeen files by hand, in
 * order, with no way to tell whether the fourth one failed, is how a chain gets
 * applied half-way and stays there.
 *
 * The whole thing is wrapped in one transaction. Every statement in the chain is
 * transaction-safe (checked: no CREATE INDEX CONCURRENTLY, no VACUUM), so a
 * failure anywhere rolls the entire schema back and leaves the database exactly as
 * it was — which is the behaviour you want from a first application.
 *
 * Generated, not authored: `supabase/apply-all.sql` must never be edited by hand.
 * Edit the migration it came from and regenerate.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = 'supabase/migrations';
const OUTPUT = 'supabase/apply-all.sql';

const files = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith('.sql'))
  .sort();

if (files.length === 0) {
  console.error('bundle-migrations: no migrations found');
  process.exit(1);
}

const header = `-- GENERATED FILE — do not edit. Run \`npm run db:bundle\` instead.
--
-- The whole migration chain in one transaction, for applying it through the
-- Supabase dashboard's SQL editor:
--
--   1. open the project → SQL Editor → New query
--   2. paste this entire file
--   3. Run. Either every migration applies, or none of them does.
--
-- ${files.length} migrations, applied in filename order, wrapped in one
-- transaction on purpose: a chain applied half-way is worse than one that has not
-- started, because the next attempt then fails on objects that already exist.
--
-- After it succeeds, check the advisors (Advisors → Security) for any table
-- without row level security, and then verify with:
--   select count(*) from pg_tables where schemaname = 'public';   -- 84
`;

const parts = files.map((name) => {
  const sql = readFileSync(join(MIGRATIONS_DIR, name), 'utf8').trimEnd();
  return `-- ─────────────────────────────────────────────────────────────────────────────\n-- ${name}\n-- ─────────────────────────────────────────────────────────────────────────────\n\n${sql}\n`;
});

const bundle = `${header}\nbegin;\n\n${parts.join('\n')}\ncommit;\n`;
writeFileSync(OUTPUT, bundle, 'utf8');

const lines = bundle.split('\n').length;
console.log(`bundle-migrations: ${files.length} migrations → ${OUTPUT} (${lines} lines)`);
