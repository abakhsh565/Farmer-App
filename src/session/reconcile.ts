/**
 * Making the app's idea of "signed in" agree with the server's.
 *
 * The app has two records of the same fact and neither can be trusted alone:
 *
 *  · the session document on the phone (`agri-shop.session`) — who this device
 *    says is signed in, written by the credential sheet and read by every screen;
 *  · the Supabase session in the WebView's storage — the access token the database
 *    actually checks.
 *
 * They are written by different code at different moments, so they can disagree in
 * both directions, and each disagreement has a distinct, wrong symptom:
 *
 *  · the document says signed in while the token is gone — the farmer sees their
 *    name in the header, chooses a location, and the server answers "Sign in to
 *    save a location." That is the bug this module is for.
 *  · the document says guest while a valid token survives — a reinstall, a cleared
 *    document, a launch that raced the token restore. The app then asks a farmer
 *    who is already signed in to sign in again, and cannot read the location they
 *    had saved.
 *  · both agree that somebody is signed in, but the party row is missing or the
 *    document never learned its id — every write is refused even though the token
 *    is perfectly good.
 *
 * Reconciling on launch (and when the app comes back to the foreground) settles all
 * three before a screen can hit them, and does it in one place rather than in each
 * feature. Nothing here decides *permission*: the server still does that. This only
 * makes the app stop lying to itself about who it is talking to.
 */

import { fromE164 } from '@/services/supabaseClient';
import { backendConfigured, resolvePartyId, sessionUser } from '@/services/party';
import type { SessionState } from './store';

/** The account the app should show, when the server has a session the document lost. */
export type AdoptedIdentity = {
  /** The auth uid, used as the account id only until a party id is known. */
  userId: string;
  /** The contact as the app writes it: national digits, or the address. */
  contact: string;
  phone: string | null;
  email: string | null;
  partyId: string | null;
};

export type Reconciliation =
  | { kind: 'unchanged' }
  /** Somebody is signed in and the document now knows their real key. */
  | { kind: 'party'; partyId: string }
  /** A valid session outlived the app's own record of it: adopt it, silently. */
  | { kind: 'adopt'; identity: AdoptedIdentity }
  /** The document claims a session the server no longer has. */
  | { kind: 'expired' };

/**
 * Compare, then say what has to change. Does not change anything itself.
 *
 * Pure in the sense that matters for testing: the same document and the same
 * server answer always produce the same verdict, and the caller decides whether to
 * apply it. `sessionUser()` and the party call are injected-free but cheap — the
 * session read is local storage and `ensure_party` is one RPC.
 */
export async function reconcileSession(state: SessionState): Promise<Reconciliation> {
  if (!backendConfigured()) return { kind: 'unchanged' };

  const user = await sessionUser();

  if (state.account === null) {
    /*
     * A guest. That is only wrong when the server still holds a session — which
     * happens after a cleared document or a reinstall, and which the app must not
     * resolve by asking for a code the farmer already gave.
     */
    if (!user) return { kind: 'unchanged' };

    const partyId = await resolvePartyId();
    const contact = user.phone ? fromE164(user.phone) : (user.email ?? '');

    return {
      kind: 'adopt',
      identity: {
        userId: user.id,
        contact,
        phone: user.phone ? fromE164(user.phone) : null,
        email: user.email,
        partyId,
      },
    };
  }

  /*
   * The document says signed in. If the server disagrees, the honest state is
   * "signed out" — keeping the account would let the farmer keep choosing things
   * the server will refuse, which is precisely the confusion being fixed. The
   * caller shows the sheet's own sentence rather than a silent disappearance.
   */
  if (!user) return { kind: 'expired' };

  const partyId = await resolvePartyId();

  /*
   * The party call failing is not evidence against the session: it is a cold start,
   * a dropped request, or a backend mid-deploy. Keeping the account is right, and
   * the next reconciliation (or the write that needs it) repairs the id.
   */
  if (!partyId) return { kind: 'unchanged' };
  if (state.account.partyId === partyId) return { kind: 'unchanged' };

  return { kind: 'party', partyId };
}

/**
 * Whether a refusal is the "your session has no party" shape.
 *
 * Used by the location write to decide whether `ensure_party` plus one retry can
 * fix it. Deliberately narrow: these are the messages Postgres, PostgREST and the
 * app's own functions produce for that state, not every permission error — a
 * genuine "you may not do this" must not be retried into a second identical
 * failure.
 */
export function needsPartyRepair(message: string): boolean {
  return /sign in to|not authenticated|no party|party id|jwt|row-level security|permission denied for function|invalid claim/i.test(
    message,
  );
}
