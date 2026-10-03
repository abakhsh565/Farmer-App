import { describe, expect, it } from 'vitest';
import {
  cancelRequest,
  createState,
  hydrate,
  isEmail,
  isPhone,
  isGuest,
  markContextMigrated,
  requestAccount,
  serialise,
  signIn,
  signOut,
  validateContact,
} from './store';

/**
 * Identity-on-action, as rules: reading never needs an account, an accountable
 * action records *why* it is asking, and signing in adopts the guest context
 * instead of discarding it.
 */

describe('contact validation', () => {
  it('accepts the ways a Pakistani mobile number is actually written', () => {
    expect(isPhone('0300 1234567')).toBe(true);
    expect(isPhone('0300-1234567')).toBe(true);
    expect(isPhone('03001234567')).toBe(true);
  });

  it('refuses numbers that are not eleven digits starting 03', () => {
    expect(isPhone('1234567890')).toBe(false);
    expect(isPhone('0300123')).toBe(false);
    expect(isPhone('00923001234567')).toBe(false);
  });

  it('accepts an email and refuses an unfinished one', () => {
    expect(isEmail('bilal@example.com')).toBe(true);
    expect(isEmail('bilal@example')).toBe(false);
    expect(isEmail('bilal.example.com')).toBe(false);
  });

  it('names the missing field before the wrong one', () => {
    expect(validateContact('phone', '  ')).toBe('session.error.phoneRequired');
    expect(validateContact('phone', '123')).toBe('session.error.phone');
    expect(validateContact('email', '')).toBe('session.error.emailRequired');
    expect(validateContact('email', 'nope')).toBe('session.error.email');
    expect(validateContact('phone', '0300 1234567')).toBeNull();
  });
});

describe('the gate', () => {
  it('is a guest until sign-in, and remembers why it asked', () => {
    const guest = requestAccount(createState(), 'session.why.post');
    expect(isGuest(guest)).toBe(true);
    expect(guest.pendingReason).toBe('session.why.post');
  });

  it('drops the request when the farmer keeps browsing', () => {
    const state = cancelRequest(requestAccount(createState(), 'session.why.credit'));
    expect(state.pendingReason).toBeNull();
    expect(state.account).toBeNull();
  });

  it('refuses an account for an invalid contact and creates none', () => {
    const { state, result } = signIn(createState(), { method: 'phone', contact: '123' }, 1);
    expect(result.ok).toBe(false);
    expect(state.account).toBeNull();
  });

  it('clears the pending action when sign-in succeeds', () => {
    const { state, result } = signIn(
      requestAccount(createState(), 'session.why.message'),
      { method: 'phone', contact: '0300 1234567', name: 'Bilal' },
      1000,
    );
    expect(result.ok).toBe(true);
    expect(state.account?.name).toBe('Bilal');
    expect(state.account?.phone).toBe('0300 1234567');
    expect(state.pendingReason).toBeNull();
  });

  it('names an account by its last four digits when no name is given', () => {
    const { state } = signIn(createState(), { method: 'phone', contact: '0300 1234567' }, 1);
    expect(state.account?.name).toBe('****4567');
  });

  it('supports email as well as phone, per the accepted baseline', () => {
    const { state } = signIn(createState(), { method: 'email', contact: 'bilal@example.com' }, 1);
    expect(state.account?.method).toBe('email');
    expect(state.account?.email).toBe('bilal@example.com');
    expect(state.account?.phone).toBeNull();
  });

  it('keeps the guest farming context through sign-out', () => {
    const signedIn = markContextMigrated(
      signIn(createState(), { method: 'phone', contact: '0300 1234567' }, 1).state,
    );
    const out = signOut(signedIn);
    expect(out.account).toBeNull();
    expect(out.contextMigrated).toBe(true);
  });

  it('reads back an account, and a pending action never survives a reload', () => {
    const signedIn = requestAccount(
      signIn(createState(), { method: 'phone', contact: '0300 1234567' }, 1).state,
      'session.why.credit',
    );
    const restored = hydrate(serialise(signedIn));
    expect(restored?.account?.phone).toBe('0300 1234567');
    expect(restored?.pendingReason).toBeNull();
  });

  it('treats junk in storage as no session rather than crashing', () => {
    expect(hydrate('not json')).toBeNull();
    expect(hydrate('{"account":{"id":5}}')).toBeNull();
    expect(hydrate(null)).toBeNull();
  });
});
