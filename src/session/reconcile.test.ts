import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, SessionState } from './store';

/**
 * The reconciliation table, stated as tests.
 *
 * Each case is a way the phone and the server can disagree, and the answer the app
 * must give. Two of them are the bug the module exists for and its mirror image:
 * a document that claims a session the server does not have (sign out, but only
 * once that is proven), and a read that simply failed — offline, a cold start — which
 * must never cost a farmer their account.
 *
 * `confirmDelayMs: 0` everywhere: the second look is the same behaviour without
 * waiting out the real confirmation window.
 */

const { backendConfigured, probeSession, resolvePartyId } = vi.hoisted(() => ({
  backendConfigured: vi.fn(),
  probeSession: vi.fn(),
  resolvePartyId: vi.fn(),
}));

vi.mock('@/services/party', () => ({
  backendConfigured: () => backendConfigured(),
  probeSession: () => probeSession(),
  resolvePartyId: () => resolvePartyId(),
}));

import { reconcileSession } from './reconcile';

const PRESENT = { status: 'present', user: { id: 'auth-9', phone: '+923001234567', email: null } };
const ABSENT = { status: 'absent' };
const UNKNOWN = { status: 'unknown' };

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'party-1',
    name: 'Farmer',
    phone: '03001234567',
    email: null,
    method: 'phone',
    verifiedAt: 1,
    partyId: 'party-1',
    ...overrides,
  };
}

function signedIn(overrides: Partial<Account> = {}): SessionState {
  return { account: account(overrides), pendingReason: null, contextMigrated: true };
}

const guest: SessionState = { account: null, pendingReason: null, contextMigrated: false };

const settle = (state: SessionState) => reconcileSession(state, { confirmDelayMs: 0 });

describe('reconcileSession', () => {
  beforeEach(() => {
    backendConfigured.mockReturnValue(true);
    probeSession.mockReset();
    resolvePartyId.mockReset();
  });

  it('does nothing on a build with no backend, because there is nothing to ask', async () => {
    backendConfigured.mockReturnValue(false);
    expect(await settle(signedIn())).toEqual({ kind: 'unchanged' });
    expect(probeSession).not.toHaveBeenCalled();
  });

  it('keeps a signed-in farmer when the session could not be read at all', async () => {
    // Offline, or a cold start that raced the token restore. Not a sign-out.
    probeSession.mockResolvedValue(UNKNOWN);
    expect(await settle(signedIn())).toEqual({ kind: 'unchanged' });
  });

  it('keeps a guest when the session could not be read at all', async () => {
    probeSession.mockResolvedValue(UNKNOWN);
    expect(await settle(guest)).toEqual({ kind: 'unchanged' });
  });

  it('leaves a guest alone when the server has no session either', async () => {
    probeSession.mockResolvedValue(ABSENT);
    expect(await settle(guest)).toEqual({ kind: 'unchanged' });
  });

  it('signs out only when two reads agree the session is gone', async () => {
    probeSession.mockResolvedValue(ABSENT);
    expect(await settle(signedIn())).toEqual({ kind: 'expired' });
    expect(probeSession).toHaveBeenCalledTimes(2);
  });

  it('keeps the account when the second look cannot answer', async () => {
    // The first read said absent, the confirmation failed: no proof, no sign-out.
    probeSession.mockResolvedValueOnce(ABSENT).mockResolvedValueOnce(UNKNOWN);
    expect(await settle(signedIn())).toEqual({ kind: 'unchanged' });
  });

  it('adopts a session that outlived the phone’s own record of it', async () => {
    probeSession.mockResolvedValue(PRESENT);
    resolvePartyId.mockResolvedValue('party-9');

    const outcome = await settle(guest);

    /*
     * The contact comes back in the form the farmer would have typed. A profile
     * showing `+923001234567` is a number no screen in this app accepts.
     */
    expect(outcome).toEqual({
      kind: 'adopt',
      identity: {
        userId: 'auth-9',
        contact: '03001234567',
        phone: '03001234567',
        email: null,
        partyId: 'party-9',
      },
    });
  });

  it('records the party id an account was missing', async () => {
    probeSession.mockResolvedValue(PRESENT);
    resolvePartyId.mockResolvedValue('party-9');

    // Signed in, but the document never learned its key — every write is refused
    // with "Sign in to save a location." until this is applied.
    const outcome = await settle(signedIn({ id: 'phone:03001234567', partyId: null }));
    expect(outcome).toEqual({ kind: 'party', partyId: 'party-9' });
  });

  it('does not churn when the document already knows the right party', async () => {
    probeSession.mockResolvedValue(PRESENT);
    resolvePartyId.mockResolvedValue('party-1');
    expect(await settle(signedIn())).toEqual({ kind: 'unchanged' });
  });

  it('keeps the account when the party call itself fails', async () => {
    probeSession.mockResolvedValue(PRESENT);
    resolvePartyId.mockResolvedValue(null);
    expect(await settle(signedIn())).toEqual({ kind: 'unchanged' });
  });
});
