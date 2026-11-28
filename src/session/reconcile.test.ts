import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, SessionState } from './store';

/**
 * The reconciliation table, stated as tests.
 *
 * Each case is a way the phone and the server can disagree, and the answer the app
 * must give. The bug that prompted this module was the fourth row — a document that
 * says "signed in" while the server has no session — so that one is asserted by name
 * rather than left implied by the others.
 */

const { backendConfigured, resolvePartyId, sessionUser } = vi.hoisted(() => ({
  backendConfigured: vi.fn(),
  resolvePartyId: vi.fn(),
  sessionUser: vi.fn(),
}));

vi.mock('@/services/party', () => ({
  backendConfigured: () => backendConfigured(),
  resolvePartyId: () => resolvePartyId(),
  sessionUser: () => sessionUser(),
}));

import { needsPartyRepair, reconcileSession } from './reconcile';

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

describe('reconcileSession', () => {
  beforeEach(() => {
    backendConfigured.mockReturnValue(true);
    resolvePartyId.mockReset();
    sessionUser.mockReset();
  });

  it('does nothing on a build with no backend, because there is nothing to ask', async () => {
    backendConfigured.mockReturnValue(false);
    expect(await reconcileSession(signedIn())).toEqual({ kind: 'unchanged' });
    expect(sessionUser).not.toHaveBeenCalled();
  });

  it('leaves a guest alone when the server has no session either', async () => {
    sessionUser.mockResolvedValue(null);
    expect(await reconcileSession(guest)).toEqual({ kind: 'unchanged' });
  });

  it('adopts a session that outlived the phone’s own record of it', async () => {
    sessionUser.mockResolvedValue({ id: 'auth-9', phone: '+923001234567', email: null });
    resolvePartyId.mockResolvedValue('party-9');

    const outcome = await reconcileSession(guest);

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

  it('signs out when the document claims a session the server no longer has', async () => {
    sessionUser.mockResolvedValue(null);
    expect(await reconcileSession(signedIn())).toEqual({ kind: 'expired' });
  });

  it('records the party id an account was missing', async () => {
    sessionUser.mockResolvedValue({ id: 'auth-9', phone: '+923001234567', email: null });
    resolvePartyId.mockResolvedValue('party-9');

    // Signed in, but the document never learned its key — every write is refused
    // with "Sign in to save a location." until this is applied.
    const outcome = await reconcileSession(signedIn({ id: 'phone:03001234567', partyId: null }));
    expect(outcome).toEqual({ kind: 'party', partyId: 'party-9' });
  });

  it('does not churn when the document already knows the right party', async () => {
    sessionUser.mockResolvedValue({ id: 'auth-9', phone: '+923001234567', email: null });
    resolvePartyId.mockResolvedValue('party-1');
    expect(await reconcileSession(signedIn())).toEqual({ kind: 'unchanged' });
  });

  it('keeps the account when the party call itself fails', async () => {
    sessionUser.mockResolvedValue({ id: 'auth-9', phone: '+923001234567', email: null });
    resolvePartyId.mockResolvedValue(null);
    expect(await reconcileSession(signedIn())).toEqual({ kind: 'unchanged' });
  });
});

describe('needsPartyRepair', () => {
  it('recognises the refusal a session without a party produces', () => {
    expect(needsPartyRepair('Sign in to save a location.')).toBe(true);
    expect(needsPartyRepair('new row violates row-level security policy')).toBe(true);
    expect(needsPartyRepair('JWT expired')).toBe(true);
  });

  it('leaves every other refusal alone', () => {
    expect(needsPartyRepair('Latitude must be between -90 and 90.')).toBe(false);
    expect(needsPartyRepair('A location name is required.')).toBe(false);
  });
});
