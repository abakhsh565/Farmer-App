#!/usr/bin/env node
/**
 * Creates — or repairs — the demo farmers that the app's demo sign-in expects.
 *
 * WHY THIS EXISTS
 *
 * `src/services/demoAuth.ts` signs in to accounts that already exist: the demo
 * sheet displays a fixed code, and that code is only useful because it is the
 * account's password. It deliberately never creates an account, because the
 * brief requires that signing in repeatedly resolves to the *same* farmer and the
 * same data. So the accounts have to be provisioned once, out of band — which is
 * what this does, and the only step the demo sign-in cannot do for itself.
 *
 * It is idempotent, so running it twice is not a mistake: a destination that
 * already exists has its password and confirmation set to the configured value,
 * and keeps its id, its party and its data. That property is the whole point —
 * a fresh account on every run would give every demo session an empty app.
 *
 * WHERE THE CREDENTIALS COME FROM
 *
 * Three values, from the process environment or `.env.local` beside this file:
 *
 *   VITE_SUPABASE_URL              the project the app already points at
 *   VITE_DEMO_FARMERS              the same variable the app reads, parsed by
 *                                  the same function (`parseDemoIdentities`), so
 *                                  the accounts created here are exactly the ones
 *                                  the sheet will accept
 *   SUPABASE_SERVICE_ROLE_KEY      the admin credential — required, never printed
 *
 * The service-role key is the one thing that cannot be committed: it can create
 * and delete any user in the project. It is read from the environment and never
 * echoed. If it is absent the script says so and stops, rather than reporting a
 * success it cannot verify.
 *
 * This is the same request the Supabase dashboard makes when you add a user by
 * hand; it is the supported administrative path, not a workaround. Nothing here
 * touches row-level security, and the accounts it creates are ordinary ones: they
 * sign in through `/auth/v1/token`, hold a real access token, and every policy
 * applies to them exactly as it does to a production farmer.
 *
 * RUN
 *
 *   SUPABASE_SERVICE_ROLE_KEY=... npm run provision:demo
 *
 * Verified against a local Supabase stack; see the report for what was measured.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDemoIdentities, type DemoIdentity } from '../src/services/demoAuth.ts';
import { toE164 } from '../src/services/supabaseClient.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** `.env.local` is where Vite puts the app's own configuration; read it the same way. */
function readEnvFile(file: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

/** Process environment wins over the file, which is how Vite resolves it too. */
function setting(fileValues: Record<string, string>, key: string): string {
  return (process.env[key] ?? fileValues[key] ?? '').trim();
}

/**
 * A destination, reduced to something that can be printed.
 *
 * The report and the console are not a place for the demo credentials, and the
 * person running this already has them in `.env.local`. Enough is shown to tell
 * two accounts apart, which is all this output is for.
 */
function maskDestination(channel: DemoIdentity['channel'], destination: string): string {
  if (channel === 'email') {
    const at = destination.indexOf('@');
    const local = destination.slice(0, at);
    return `${local.slice(0, 1)}${'*'.repeat(Math.max(1, local.length - 1))}${destination.slice(at)}`;
  }
  const head = destination.slice(0, 4);
  const tail = destination.slice(-2);
  return `${head}${'*'.repeat(Math.max(1, destination.length - 6))}${tail}`;
}

/** The identifier GoTrue stores: digits for a phone, lowercased for an email. */
function storedPhone(destination: string): string {
  return toE164(destination).replace(/[^0-9]/g, '');
}

type AuthUser = { id: string; email?: string | null; phone?: string | null };

async function api(url: string, key: string, path: string, init?: RequestInit) {
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { ok: response.ok, status: response.status, body };
}

async function listUsers(url: string, key: string): Promise<AuthUser[]> {
  const users: AuthUser[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const { ok, body } = await api(url, key, `/auth/v1/admin/users?page=${page}&per_page=200`);
    if (!ok) throw new Error('Could not list users — is the service-role key correct for this project?');
    const batch = (body as { users?: AuthUser[] })?.users ?? [];
    users.push(...batch);
    if (batch.length < 200) break;
  }
  return users;
}

/** Who an identity already is, matched the way the sign-in will match it. */
function findExisting(users: AuthUser[], identity: DemoIdentity): AuthUser | undefined {
  if (identity.channel === 'email') {
    return users.find((user) => (user.email ?? '').toLowerCase() === identity.destination);
  }
  const wanted = storedPhone(identity.destination);
  return users.find((user) => (user.phone ?? '').replace(/[^0-9]/g, '') === wanted);
}

async function main(): Promise<number> {
  const fileValues = readEnvFile(join(ROOT, '.env.local'));
  const url = setting(fileValues, 'VITE_SUPABASE_URL');
  const serviceKey = setting(fileValues, 'SUPABASE_SERVICE_ROLE_KEY');
  const identities = parseDemoIdentities(setting(fileValues, 'VITE_DEMO_FARMERS'));

  if (url === '') {
    console.error('VITE_SUPABASE_URL is not set. Point it at the project the app uses, then run this again.');
    return 1;
  }
  if (identities === null) {
    console.error(
      'VITE_DEMO_FARMERS is not set (or holds no usable identity). Set it to the same value the app reads — ' +
        '.env.example has a working example — then run this again.',
    );
    return 1;
  }
  if (serviceKey === '') {
    console.error(
      [
        'SUPABASE_SERVICE_ROLE_KEY is not set, so no account could be created.',
        '',
        'This is the only step the demo sign-in cannot do for itself: creating an account needs the admin',
        'credential, and the app deliberately never holds one. The key is in the dashboard under',
        'Project Settings → API → service_role. It can create and delete any user, so it is not committed —',
        'pass it for this one command and nothing else:',
        '',
        '  SUPABASE_SERVICE_ROLE_KEY=<the key> npm run provision:demo',
        '',
        'Alternatively add the key to .env.local, which is git-ignored, and run the command above without the',
        'prefix. Either way it is never printed here.',
      ].join('\n'),
    );
    return 1;
  }

  const base = url.replace(/\/+$/, '');
  console.log(`Project:    ${base}`);
  console.log(`Identities: ${identities.identities.length} configured\n`);

  const users = await listUsers(base, serviceKey);
  let created = 0;
  let repaired = 0;

  for (const identity of identities.identities) {
    const existing = findExisting(users, identity);
    const label = `${identity.name} · ${identity.channel} · ${maskDestination(identity.channel, identity.destination)}`;

    const credential =
      identity.channel === 'phone'
        ? { phone: toE164(identity.destination) }
        : { email: identity.destination };

    if (existing) {
      /*
       * Every field is written on purpose, not just the password: a demo account
       * that a previous run left unconfirmed would still fail to sign in, and that
       * failure would look like the app's fault.
       */
      const { ok, body } = await api(base, serviceKey, `/auth/v1/admin/users/${existing.id}`, {
        method: 'PUT',
        body: JSON.stringify({ password: identity.code, email_confirm: true, phone_confirm: true }),
      });
      if (!ok) {
        console.error(`  FAILED  ${label} — ${JSON.stringify(body)}`);
        return 1;
      }
      repaired += 1;
      console.log(`  kept     ${label} — existing account, password and confirmation reset (${existing.id.slice(0, 8)}…)`);
      continue;
    }

    const { ok, status, body } = await api(base, serviceKey, '/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        ...credential,
        password: identity.code,
        email_confirm: true,
        phone_confirm: true,
        user_metadata: { demo: true, display_name: identity.name },
      }),
    });
    if (!ok) {
      console.error(`  FAILED  ${label} — HTTP ${status} ${JSON.stringify(body)}`);
      return 1;
    }
    const id = (body as { id?: string })?.id ?? '';
    created += 1;
    console.log(`  created  ${label} — new account (${id.slice(0, 8)}…)`);
  }

  console.log(
    `\n${created} created, ${repaired} kept. Sign in with the configured code; the password is never printed.`,
  );
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`Provisioning failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
