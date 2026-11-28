/**
 * The party behind a session — one place that asks, one place that remembers why.
 *
 * A Supabase session proves *who is holding the phone*. Every row-level policy in
 * the database matches on `current_party_id()`, which is a different fact: the
 * domain actor (a farmer, a shop, a driver) the session resolves to. The two are
 * created together by a signup trigger, but they can drift apart — an account that
 * predates the trigger, a sign-in that happened while the backend was briefly
 * unreachable, or a session document written before the app recorded party ids at
 * all. When they drift, the app *looks* signed in and the server refuses every
 * write with "Sign in to save a location."
 *
 * `ensure_party()` is the idempotent repair for exactly that state, and it is the
 * only API this module exists to reach. It is not an authorisation check: it
 * returns the party id for a session the server has already issued, and the
 * database recomputes the same answer for every policy. Asking it is therefore
 * always safe, which is what lets callers repair on demand instead of failing.
 */

import { serviceConfig } from './config';
import {
  currentSession,
  getSupabaseClient,
  type SessionProbe,
  type SupabaseLike,
} from './supabaseClient';

/**
 * The party id for the session on this client, creating the row if it is missing.
 *
 * Returns null rather than throwing when the backend does not answer: a session
 * without a party id is a state the app can represent, and turning it into an
 * exception here would make every caller handle a failure that might simply be a
 * cold start.
 */
export async function ensureParty(client: SupabaseLike): Promise<string | null> {
  try {
    const { data, error } = await client.rpc('ensure_party');
    if (error) return null;
    return typeof data === 'string' && data.length > 0 ? data : null;
  } catch {
    return null;
  }
}

/**
 * Whether this build has a backend to consult at all.
 *
 * A build without one keeps its account on the phone, and reconciling it against a
 * server that does not exist would sign the farmer out of an app that is working
 * exactly as designed.
 */
export function backendConfigured(): boolean {
  return serviceConfig.supabase.configured;
}

/** The party id for whoever is signed in right now, or null for a guest. */
export async function resolvePartyId(): Promise<string | null> {
  if (!backendConfigured()) return null;
  const client = await getSupabaseClient(serviceConfig.supabase);
  if (!client) return null;
  return ensureParty(client);
}

/**
 * Whether a session is present, absent, or simply unreadable right now.
 *
 * The third answer is the point: a client that could not be created, a storage
 * read that threw, or a token refresh that failed offline are not evidence that
 * the farmer signed out, and callers must be able to tell them apart from the
 * client's own "nobody is signed in".
 */
export async function probeSession(): Promise<SessionProbe> {
  if (!backendConfigured()) return { status: 'unknown' };
  const client = await getSupabaseClient(serviceConfig.supabase);
  if (!client) return { status: 'unknown' };
  return currentSession();
}

/**
 * Whether a refusal is the "your session has no party" shape.
 *
 * Lives here, beside `ensureParty`, because it is the recognition half of the same
 * repair: the write calls this to decide whether `ensure_party` plus one retry can
 * fix the refusal. Deliberately narrow — these are the messages Postgres, PostgREST
 * and the app's own functions produce for that state, not every permission error. A
 * genuine "you may not do this" must not be retried into a second identical
 * failure, and the services layer must not have to reach into `src/session` to
 * learn that.
 */
export function needsPartyRepair(message: string): boolean {
  return /sign in to|not authenticated|no party|party id|jwt|row-level security|permission denied for function|invalid claim/i.test(
    message,
  );
}
