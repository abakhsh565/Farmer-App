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
 *
 * ## Signing out needs proof, not an empty read
 *
 * "No session" and "I could not read the session" both used to arrive as `null`,
 * so this module would sign a farmer out for opening the app offline, or for a cold
 * start that raced the token restore — the same class of surprise as the bug it was
 * written to fix, in the opposite direction. The read now answers present / absent /
 * unknown, only `absent` counts, and even that is asked twice a moment apart. An
 * account is dropped when the client has twice confirmed there is nothing to keep,
 * and never on the strength of one empty answer.
 */

import { fromE164, type SessionProbe } from '@/services/supabaseClient';
import { backendConfigured, probeSession, resolvePartyId } from '@/services/party';
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
  /** The document claims a session that two reads agree the server does not have. */
  | { kind: 'expired' };

/**
 * How long to wait before asking a second time whether the session is really gone.
 *
 * Long enough for a token restore or a refresh that was in flight to finish, short
 * enough that a genuinely removed account does not sit on a stale header. It only
 * ever runs on the narrow path where the document says signed in and the first read
 * said otherwise.
 */
const CONFIRM_ABSENCE_MS = 1200;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A second, later read, and whether it also says "absent".
 *
 * `unknown` on the second read is not a confirmation — it is the opposite, which is
 * why the check is `=== 'absent'` rather than `!== 'present'`.
 */
async function absenceConfirmed(delayMs: number): Promise<boolean> {
  if (delayMs > 0) await wait(delayMs);
  const second: SessionProbe = await probeSession();
  return second.status === 'absent';
}

/**
 * Compare, then say what has to change. Does not change anything itself.
 *
 * Pure in the sense that matters for testing: the same document and the same
 * server answer always produce the same verdict, and the caller decides whether to
 * apply it. `probeSession()` and the party call are cheap — a local storage read and
 * one RPC.
 *
 * `confirmDelayMs` exists so a test does not have to wait out the confirmation
 * window; production never passes it.
 */
export async function reconcileSession(
  state: SessionState,
  options: { confirmDelayMs?: number } = {},
): Promise<Reconciliation> {
  if (!backendConfigured()) return { kind: 'unchanged' };

  const probe = await probeSession();

  /*
   * No usable answer. Keeping whatever the phone already believes is right: this is
   * a cold start, an offline launch, or a backend mid-deploy, and none of those are
   * a reason to take an account away from a farmer.
   */
  if (probe.status === 'unknown') return { kind: 'unchanged' };

  if (probe.status === 'absent') {
    // A guest with no session is the ordinary case, not a mismatch.
    if (state.account === null) return { kind: 'unchanged' };

    /*
     * The document says signed in and the client says there is nothing. One empty
     * read is not proof — ask again, and only then drop the account. The caller
     * shows the sheet's own sentence rather than a silent disappearance.
     */
    if (!(await absenceConfirmed(options.confirmDelayMs ?? CONFIRM_ABSENCE_MS))) {
      return { kind: 'unchanged' };
    }
    return { kind: 'expired' };
  }

  const user = probe.user;

  if (state.account === null) {
    /*
     * A guest, but the server still holds a session — after a cleared document or a
     * reinstall, and the app must not resolve that by asking for a code the farmer
     * already gave.
     */
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
