#!/usr/bin/env node
/**
 * Static check over the Edge Function sources.
 *
 * The functions cannot be executed here: there is no Deno runtime, no Docker and
 * no deployed project. Shipping them unread is how a gateway ends up deployed
 * with a route the client cannot reach, or with a vendor key inlined into the
 * source it was supposed to keep out of the client.
 *
 * This is the same trade the migration checker makes — it cannot prove the code
 * runs, and it does catch the mistakes that are actually likely:
 *
 *   1. A route the function handles that the client never calls, or a route the
 *      client calls that the function does not handle. This is the failure that
 *      would otherwise surface as a 404 on a farmer's phone.
 *   2. A secret referenced by name that is not read from `Deno.env` — i.e. a
 *      value that has been written into the source.
 *   3. A key-looking literal (`sk-…`, `sb_secret_…`, a JWT) anywhere in the
 *      functions directory. These ship to the server, but they also get committed,
 *      and a key in git is a key that has leaked.
 *   4. A `VITE_`-style name used on the server, which would mean the value is
 *      being read from the client's bundle rather than from the server's
 *      environment.
 *   5. A table written by a function that no migration creates.
 *
 * Exit code is non-zero when any check fails, so this can gate a pipeline.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FUNCTIONS_DIR = 'supabase/functions';
const MIGRATIONS_DIR = 'supabase/migrations';

const errors = [];

/* -------------------------------------------------------------------------- */
/* Collect the sources                                                        */
/* -------------------------------------------------------------------------- */

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const files = walk(FUNCTIONS_DIR).sort();
if (files.length === 0) {
  errors.push(`no .ts files found in ${FUNCTIONS_DIR}`);
}

/**
 * Removes comments before scanning.
 *
 * The rule is about code, not prose: these files document at length *why* the
 * key is read from `Deno.env` and *why* a `VITE_` name would be wrong, and a
 * checker that flags its own documentation is a checker people learn to ignore.
 * String literals are kept, because a key literal is exactly what is being
 * looked for.
 */
function stripComments(sql) {
  let out = '';
  let i = 0;
  let inLine = false;
  let inBlock = false;
  let quote = null;

  while (i < sql.length) {
    const two = sql.slice(i, i + 2);

    if (inLine) {
      if (sql[i] === '\n') {
        inLine = false;
        out += '\n';
      }
      i += 1;
      continue;
    }

    if (inBlock) {
      if (two === '*/') {
        inBlock = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (quote) {
      if (sql[i] === '\\') {
        out += sql.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (sql[i] === quote) quote = null;
      out += sql[i];
      i += 1;
      continue;
    }

    if (two === '//') {
      inLine = true;
      i += 2;
      continue;
    }
    if (two === '/*') {
      inBlock = true;
      i += 2;
      continue;
    }
    if (sql[i] === '"' || sql[i] === "'" || sql[i] === '`') {
      quote = sql[i];
      out += sql[i];
      i += 1;
      continue;
    }

    out += sql[i];
    i += 1;
  }

  return out;
}

const sources = new Map();
for (const file of files) {
  sources.set(file, readFileSync(file, 'utf8'));
}

/** The same sources with comments removed, used for the literal scans. */
const code = new Map();
for (const [file, text] of sources) {
  code.set(file, stripComments(text));
}

/* -------------------------------------------------------------------------- */
/* 1. Routes match between client and function                                */
/* -------------------------------------------------------------------------- */

/** Routes the server handles, per function. */
const serverRoutes = new Map();
for (const [file, text] of sources) {
  if (!file.endsWith('index.ts')) continue;
  const fn = file.replace(/\\/g, '/').split('/').slice(-2, -1)[0];
  const handled = new Set();

  // `case 'ask':` inside the router switch, and `route === 'health'` guards.
  for (const m of text.matchAll(/case\s+'([a-z_-]+)'\s*:/g)) handled.add(m[1]);
  for (const m of text.matchAll(/route\s*===\s*'([a-z_-]+)'/g)) handled.add(m[1]);
  serverRoutes.set(fn, handled);
}

/**
 * Routes the client posts to, read from the provider source rather than from a
 * list written here — a list written here is the thing that goes stale.
 */
const clientCalls = new Map();
for (const [file, text] of sources) {
  if (!file.includes('_shared')) continue;
  for (const m of text.matchAll(/this\.post<[^>]*>\(\s*'\/([a-z_-]+)'/g)) {
    clientCalls.set(m[1], file);
  }
}

// The client's calls live in src/, so read them from there.
const clientSource = readFileSync('src/services/providers/remote.ts', 'utf8');
const called = new Set();
for (const m of clientSource.matchAll(/this\.post<[^>]*>\(\s*'\/([a-z_-]+)'/g)) called.add(m[1]);

const aiRoutes = serverRoutes.get('ai') ?? new Set();
const otpRoutes = serverRoutes.get('otp') ?? new Set();

for (const route of called) {
  if (!aiRoutes.has(route) && !otpRoutes.has(route)) {
    errors.push(
      `src/services/providers/remote.ts calls /${route}, which no function handles ` +
        `(ai: ${[...aiRoutes].join(', ') || 'none'}; otp: ${[...otpRoutes].join(', ') || 'none'})`,
    );
  }
}

for (const [fn, routes] of serverRoutes) {
  for (const route of routes) {
    if (route === 'health') continue;
    if (!called.has(route)) {
      errors.push(`${fn} handles /${route}, which the client never calls`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 2–4. Secrets                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Names that must come from the server's environment. A literal beside one of
 * these names is the bug this check exists for.
 */
const SERVER_SECRETS = [
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OTP_HASH_SECRET',
  'OTP_DELIVERY_TOKEN',
  'SUPABASE_SECRET_KEYS',
  'AMIS_FEED_URL',
  'AMIS_FEED_TOKEN',
  'MARKET_FEED_URL',
  'MARKET_FEED_TOKEN',
  'WEATHERAPI_KEY',
];

for (const [file, text] of code) {
  /*
   * Every secret name must be read from the environment, either directly
   * (`Deno.env.get('NAME')`) or through a local helper that itself calls
   * `Deno.env.get`. The helper form matters because a module that supports two
   * vendors naturally looks up several key names in one function — and a rule
   * that forbids that would be a rule people route around, which is worse than
   * no rule. So a mention is accepted if it sits inside a `Deno.env.get(...)`
   * call *or* inside a function whose body contains one.
   */
  const helperBodies = [];
  // Both declaration forms: `function name(...)` and `const name = (...) =>`.
  // An arrow helper is the natural way to write a multi-name lookup, and
  // missing it would flag exactly the code this rule is meant to permit.
  const helperRe = /(?:function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)[^{;]*\{/g;
  for (const m of text.matchAll(helperRe)) {
    const name = m[1] ?? m[2];
    if (!name) continue;
    const start = m.index;
    // Body ends at the matching brace, counted so nested blocks do not fool it.
    let depth = 0;
    let index = start;
    for (; index < text.length; index += 1) {
      if (text[index] === '{') depth += 1;
      else if (text[index] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    helperBodies.push({ name, body: text.slice(start, index + 1) });
  }

  /*
   * Transitive, because the natural shape is two hops: `openAiKey()` returns
   * `env('OPENAI_API_KEY')`, and the secret name appears in the outer function,
   * not in the one that calls `Deno.env`. A single-hop rule flags that code, and
   * the fix a developer would reach for is to inline the lookup — which is the
   * opposite of what this check wants.
   */
  const envReadingHelpers = new Set();
  for (let pass = 0; pass < helperBodies.length; pass += 1) {
    let grew = false;
    for (const h of helperBodies) {
      if (envReadingHelpers.has(h.name)) continue;
      const readsDirectly = /Deno\.env\.(get|has)\(/.test(h.body);
      const callsHelper = [...envReadingHelpers].some((name) =>
        new RegExp(`\\b${name}\\s*\\(`).test(h.body),
      );
      if (readsDirectly || callsHelper) {
        envReadingHelpers.add(h.name);
        grew = true;
      }
    }
    if (!grew) break;
  }

  for (const name of SERVER_SECRETS) {
    const mentions = [...text.matchAll(new RegExp(`['"\`]${name}['"\`]`, 'g'))];
    for (const mention of mentions) {
      const before = text.slice(Math.max(0, mention.index - 60), mention.index);
      if (/Deno\.env\.(get|has)\(\s*$/.test(before)) continue;

      // Otherwise: is this mention inside a function that reads the environment?
      const enclosing = helperBodies.find(
        (h) =>
          mention.index > text.indexOf(h.body) &&
          mention.index < text.indexOf(h.body) + h.body.length,
      );
      if (enclosing && envReadingHelpers.has(enclosing.name)) continue;

      errors.push(`${file}: ${name} appears outside Deno.env.get() — it may be inlined`);
    }
  }

  // A key-looking literal. None of these belong in a repository, server or not.
  if (/sk-[A-Za-z0-9_-]{20,}/.test(text)) {
    errors.push(`${file}: looks like an OpenAI key literal`);
  }
  // Google keys always begin AIza and are 39 characters.
  if (/AIza[0-9A-Za-z_-]{30,}/.test(text)) {
    errors.push(`${file}: looks like a Google/Gemini API key literal`);
  }
  if (/sb_secret_[A-Za-z0-9_-]{10,}/.test(text)) {
    errors.push(`${file}: looks like a Supabase secret key literal`);
  }
  if (/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./.test(text)) {
    errors.push(`${file}: looks like a JWT literal`);
  }

  // A client-side variable name on the server means the value is being read from
  // the wrong place: `import.meta.env` does not exist in a function.
  if (/import\.meta\.env/.test(text)) {
    errors.push(`${file}: uses import.meta.env, which does not exist in an Edge Function`);
  }
  if (/VITE_/.test(text)) {
    errors.push(`${file}: references a VITE_ variable, which is a client-side value`);
  }
}

/* -------------------------------------------------------------------------- */
/* 5. Tables written by a function exist in the chain                         */
/* -------------------------------------------------------------------------- */

const migrationsRaw = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));

// Comments stripped here too: a migration that merely *mentions* a table in a
// comment must not satisfy the check for creating it.
const migrations = migrationsRaw.map((text) => stripComments(text)).join('\n');

const created = new Set(
  [...migrations.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z_0-9]+)/gi)].map((m) =>
    m[1].toLowerCase(),
  ),
);

const EXTERNAL_TABLES = new Set(['auth.users']);

for (const [file, text] of code) {
  for (const m of text.matchAll(/\.from\(\s*'([a-z_0-9]+)'\s*\)/g)) {
    const table = m[1].toLowerCase();
    if (EXTERNAL_TABLES.has(table)) continue;
    if (!created.has(table)) {
      errors.push(`${file}: writes to public.${table}, which no migration creates`);
    }
  }

  // RPCs the functions call must exist too: a gateway that calls a missing
  // function fails at request time with a 404 that looks like a permissions bug.
  for (const m of text.matchAll(/\.rpc\(\s*'([a-z_0-9]+)'/g)) {
    const fn = m[1].toLowerCase();
    if (!new RegExp(`function\\s+public\\.${fn}\\s*\\(`, 'i').test(migrations)) {
      errors.push(`${file}: calls public.${fn}(), which no migration creates`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Output                                                                     */
/* -------------------------------------------------------------------------- */

console.log(`function sources scanned : ${files.length}`);
console.log(`comments stripped        : ${[...sources.keys()].filter((f) => sources.get(f) !== code.get(f)).length} of ${files.length}`);
console.log(`functions                : ${[...serverRoutes.keys()].join(', ') || 'none'}`);
console.log(`client routes checked    : ${[...called].join(', ') || 'none'}`);

if (errors.length > 0) {
  console.error(`\n${errors.length} problem(s) found:\n`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log('\nEdge Function checks passed.');
