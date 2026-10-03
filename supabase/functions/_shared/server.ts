/**
 * Shared server-side helpers for the Edge Functions.
 *
 * Everything in this directory runs on Supabase's infrastructure, never on a
 * farmer's device. That is the whole point of the split: `VITE_*` values are
 * published in the APK, so the OpenAI key, the SMS token and the service key can
 * only live here, where they are read from the function's environment.
 *
 * The database client is created with the service key. It therefore bypasses row
 * level security, which is correct for a trusted server component — but it also
 * means every query below must do its own authorisation, because the database is
 * no longer doing it. `requireUser()` is the gate that stands in for RLS.
 */

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

/** The project's own URL. Set automatically in every hosted function. */
export const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';

/**
 * A server-side key. Supabase supplies `SUPABASE_SERVICE_ROLE_KEY` to hosted
 * functions automatically; the newer `SUPABASE_SECRET_KEYS` bundle is preferred
 * when present, because a project using the new API-key format has no legacy
 * service_role JWT.
 *
 * Read at call time rather than module scope so a missing key is a clear 500 from
 * one request instead of a boot failure that looks like a cold-start timeout.
 */
export function serverKey(): string | null {
  const bundled = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (bundled) {
    try {
      const parsed = JSON.parse(bundled) as Record<string, string>;
      const preferred = parsed['default'] ?? Object.values(parsed)[0];
      if (preferred) return preferred;
    } catch {
      // Fall through to the legacy name rather than failing: a malformed bundle
      // should not take down a function that has a usable key beside it.
    }
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? null;
}

export function adminClient(): SupabaseClient {
  const key = serverKey();
  if (!SUPABASE_URL || !key) {
    throw new Error('Server credentials are not configured for this function.');
  }
  return createClient(SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/* -------------------------------------------------------------------------- */
/* Responses                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every response is JSON and carries CORS headers, because the APK's WebView
 * sends an Origin header and a browser-based preview does too. A function that
 * answers only same-origin is a function that works in `curl` and nowhere else.
 */
export const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export function fail(message: string, status = 400): Response {
  return json({ error: message }, status);
}

export function preflight(req: Request): Response | null {
  return req.method === 'OPTIONS' ? new Response('ok', { headers: CORS }) : null;
}

/* -------------------------------------------------------------------------- */
/* Request parsing                                                            */
/* -------------------------------------------------------------------------- */

/** The path segment after the function name, e.g. `/ai/ask` → `ask`. */
export function routeOf(req: Request, functionName: string): string {
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const at = parts.lastIndexOf(functionName);
  return (at >= 0 ? parts[at + 1] : parts[parts.length - 1]) ?? '';
}

export type AuthedCaller = {
  /** The signed-in party, or null for a guest. */
  userId: string | null;
  /** The JWT that arrived, when one did. Needed to read RLS-scoped rows. */
  token: string | null;
};

/**
 * Who is calling.
 *
 * A guest is allowed — a farmer can ask a question before signing in, and the
 * PRD treats an unauthenticated visitor as a first-class user. What is *not*
 * allowed is acting as someone else: the identity comes from the JWT that
 * `auth.getUser()` verifies, never from a field in the request body.
 */
export async function callerOf(req: Request): Promise<AuthedCaller> {
  const header = req.headers.get('Authorization') ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null;
  if (!token) return { userId: null, token: null };

  try {
    const client = adminClient();
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user) return { userId: null, token };
    return { userId: data.user.id, token };
  } catch {
    // A key that is not configured must not turn a guest request into a 500.
    return { userId: null, token };
  }
}

export async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

/** Trims and caps a caller-supplied string. Used before anything is stored. */
export function clean(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, max);
}
