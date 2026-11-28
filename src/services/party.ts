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
  currentSessionUser,
  getSupabaseClient,
  type SessionUser,
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

/** Who Supabase has a session for, or null. Local read — no network. */
export async function sessionUser(): Promise<SessionUser | null> {
  if (!backendConfigured()) return null;
  const client = await getSupabaseClient(serviceConfig.supabase);
  if (!client) return null;
  return currentSessionUser();
}
