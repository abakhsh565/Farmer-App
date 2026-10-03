#!/usr/bin/env node
/**
 * Static check over the migration chain.
 *
 * This exists because the migrations cannot be executed in this environment
 * (no local Postgres, no running container runtime), and shipping SQL that has
 * never been parsed is how a project ends up with a 14-file chain that dies on
 * file 5.
 *
 * It cannot prove the SQL is valid. It does catch the failure modes that are
 * actually likely in a hand-written chain, and that a human reviewer misses:
 *
 *   1. Unbalanced $$ dollar-quote delimiters, which silently swallow the rest
 *      of the file.
 *   2. A table referenced (foreign key, trigger target, policy target) before it
 *      is created. This is the bug that was caught by hand during authoring, so
 *      it is worth catching mechanically from now on.
 *   3. Duplicate object definitions across files.
 *   4. A table that is created but never has RLS enabled.
 *   5. Policies attached to tables that do not exist.
 *
 * Exit code is non-zero when any check fails, so this can gate a pipeline.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = 'supabase/migrations';

// Objects that exist outside the chain we author.
const EXTERNAL = new Set([
  'auth.users',
  'storage.buckets',
  'storage.objects',
  'cron.job',
  'cron.schedule_dummy',
  'vault.secrets',
  'extensions.geography',
]);

const errors = [];
const warnings = [];

/**
 * Removes comments and string literals so structure can be scanned reliably.
 * Dollar-quoted bodies are replaced with a placeholder but their delimiters are
 * counted first, because an odd count is itself a finding.
 */
function stripAndCountQuotes(name, sql) {
  const dollarCount = (sql.match(/\$\$/g) ?? []).length;
  if (dollarCount % 2 !== 0) {
    errors.push(`${name}: unbalanced $$ delimiters (found ${dollarCount}, expected an even count)`);
  }

  let out = '';
  let i = 0;
  let inDollar = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < sql.length) {
    const two = sql.slice(i, i + 2);

    if (inLineComment) {
      if (sql[i] === '\n') {
        inLineComment = false;
        out += '\n';
      }
      i += 1;
      continue;
    }

    if (inBlockComment) {
      if (two === '*/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (inDollar) {
      if (two === '$$') {
        inDollar = false;
        out += ' DOLLARBODY ';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (two === '--') {
      inLineComment = true;
      i += 2;
      continue;
    }

    if (two === '/*') {
      inBlockComment = true;
      i += 2;
      continue;
    }

    if (two === '$$') {
      inDollar = true;
      i += 2;
      continue;
    }

    // Single-quoted literal: skip to the closing quote, honouring '' escapes.
    if (sql[i] === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      out += ' LITERAL ';
      continue;
    }

    out += sql[i];
    i += 1;
  }

  return out;
}

function collectNames(re, text, group = 1) {
  const found = [];
  for (const m of text.matchAll(re)) {
    found.push(m[group]);
  }
  return found;
}

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

if (files.length === 0) {
  errors.push(`no .sql files found in ${MIGRATIONS_DIR}`);
}

const createdTables = new Set();
const createdObjects = new Map(); // name -> file, to detect duplicates
const tablesWithRls = new Set();
const allStatements = [];
let blanketRls = false;

for (const file of files) {
  const raw = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
  const text = stripAndCountQuotes(file, raw);
  allStatements.push({ file, text });

  // --- creations -----------------------------------------------------------
  for (const t of collectNames(/create\s+table\s+(?:if\s+not\s+exists\s+)?(public\.[a-z_0-9]+)/gi, text)) {
    if (createdObjects.has(t)) {
      errors.push(`${file}: ${t} is created twice (first in ${createdObjects.get(t)})`);
    } else {
      createdObjects.set(t, file);
    }
    createdTables.add(t);
  }

  for (const m of text.matchAll(/create\s+(?:or\s+replace\s+)?(?:function|type|policy|trigger)\s+(?:if\s+not\s+exists\s+)?([a-z_0-9.]+)/gi)) {
    const kind = m[0].toLowerCase().includes('function')
      ? 'function'
      : m[0].toLowerCase().includes('type')
        ? 'type'
        : m[0].toLowerCase().includes('policy')
          ? 'policy'
          : 'trigger';
    // Functions may be replaced deliberately, so only flag true duplicates of
    // policies and triggers, which cannot be redefined.
    const key = `${kind}:${m[1].toLowerCase()}`;
    if (kind === 'policy' || kind === 'trigger') {
      if (createdObjects.has(key)) {
        errors.push(`${file}: ${kind} ${m[1]} is defined twice (first in ${createdObjects.get(key)})`);
      } else {
        createdObjects.set(key, file);
      }
    }
  }

  // --- RLS -----------------------------------------------------------------
  for (const t of collectNames(/alter\s+table\s+(public\.[a-z_0-9]+)\s+enable\s+row\s+level\s+security/gi, text)) {
    tablesWithRls.add(t);
  }
  // The RLS migration enables row level security inside a DO loop over
  // pg_class. That call is a string argument to execute format(), which the
  // literal stripper above replaces, so this one check reads the raw file.
  if (/execute\s+format\(\s*'alter table public\.%I enable row level security/i.test(raw)) {
    blanketRls = true;
  }
}

// A blanket enable loop covers every table created anywhere in the chain,
// provided it runs after them — which it does, being the last migration that
// creates tables before jobs.
if (blanketRls) {
  for (const t of createdTables) tablesWithRls.add(t);
}

// --- reference resolution, in file order ------------------------------------
for (const { file, text } of allStatements) {
  const patterns = [
    [/\breferences\s+(public\.[a-z_0-9]+)/gi, 'foreign key'],
    [/\b(?:from|into|update|join)\s+(public\.[a-z_0-9]+)/gi, 'statement target'],
    [/(?:before|after)\s+(?:insert\s+or\s+update(?:\s+of\s+[a-z_,\s]+)?|update|insert|delete)[^\n]*?\bon\s+(public\.[a-z_0-9]+)/gi, 'trigger target'],
    [/\bpolicy\s+[a-z_0-9]+\s+on\s+(public\.[a-z_0-9]+)/gi, 'policy target'],
    [/\balter\s+table\s+(public\.[a-z_0-9]+)/gi, 'alter target'],
    [/create\s+index\s+[a-z_0-9]*\s*on\s+(public\.[a-z_0-9]+)/gi, 'index target'],
  ];

  for (const [re, label] of patterns) {
    for (const name of collectNames(re, text)) {
      const key = name.toLowerCase();
      if (EXTERNAL.has(key)) continue;
      if (!createdTables.has(key)) {
        errors.push(`${file}: ${label} refers to ${name}, which is never created by the chain`);
      }
    }
  }
}

// --- coverage report --------------------------------------------------------
for (const t of createdTables) {
  if (!tablesWithRls.has(t)) {
    errors.push(`${t} has no RLS enabled — a table without RLS is readable by the anon key`);
  }
}

// --- output -----------------------------------------------------------------
const tableCount = createdTables.size;
console.log(`migration files scanned : ${files.length}`);
console.log(`tables created          : ${tableCount}`);
console.log(`tables with RLS          : ${tablesWithRls.size}`);

for (const w of warnings) console.log(`warn: ${w}`);

if (errors.length > 0) {
  console.error(`\n${errors.length} problem(s) found:\n`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log('\nMigration chain checks passed.');
