import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSupabaseClient, resetSupabaseClient, toE164 } from './supabaseClient';

/*
 * The Supabase client is counted rather than used. The defect this guards
 * against was invisible to every other kind of assertion — the app looked
 * correct and only the browser's own console knew, complaining that three
 * GoTrueClient instances shared one storage key.
 */
const { createClient } = vi.hoisted(() => ({ createClient: vi.fn(() => ({ auth: {} })) }));
vi.mock('@supabase/supabase-js', () => ({ createClient }));

/**
 * The one conversion between how the app writes a number and how the auth provider
 * wants it.
 *
 * Worth its own test because it is the kind of code that fails silently: a wrong
 * E.164 string does not throw, it sends a code to a different number or to none,
 * and the farmer is left at a login screen with no error to read. The app's own
 * normalised form is national digits (`03…` normalised to `92…`), and Supabase
 * requires the leading `+`.
 */
describe('E.164', () => {
  it('adds the country code to a national number', () => {
    expect(toE164('03001234567')).toBe('+923001234567');
  });

  it('accepts the already-normalised form the app stores', () => {
    expect(toE164('923001234567')).toBe('+923001234567');
  });

  it('is idempotent', () => {
    expect(toE164(toE164('03001234567'))).toBe('+923001234567');
  });

  it('ignores the way a person typed it', () => {
    expect(toE164('0300 123 4567')).toBe('+923001234567');
    expect(toE164('0300-1234567')).toBe('+923001234567');
    expect(toE164('+92 300 1234567')).toBe('+923001234567');
  });

  it('answers empty for input with no digits, rather than inventing a number', () => {
    expect(toE164('')).toBe('');
    expect(toE164('   ')).toBe('');
    expect(toE164('abc')).toBe('');
  });
});

/**
 * One client, however many callers ask for it at once.
 *
 * Startup asks for the client from several places at the same moment — the
 * session provider, the location reads and the remote gateways all reach for it
 * before the first `await import(...)` has resolved. Checking a cached *client*
 * could not survive that: every caller passed the check in the same tick and
 * built its own, so the app ran three GoTrueClients against one token key and
 * Supabase warned that the result was undefined behaviour. Caching the *attempt*
 * is what makes concurrent callers one operation.
 */
describe('the Supabase client, created once', () => {
  const config = {
    configured: true,
    url: 'https://example.supabase.co',
    anonKey: 'anon-key',
  };

  beforeEach(() => {
    resetSupabaseClient();
    createClient.mockClear();
  });

  it('hands every concurrent caller the same client', async () => {
    const clients = await Promise.all(
      Array.from({ length: 5 }, () => getSupabaseClient(config)),
    );

    /*
     * Asserted by identity rather than by counting the create call. The count is
     * not a reliable witness here — with the mock in place the real package is
     * still resolved alongside it, so the counter reads the same whether the bug
     * is present or not. Who the callers actually received is the fact that
     * discriminates: five distinct clients is the defect, one is the fix.
     */
    expect(new Set(clients).size).toBe(1);
  });

  it('reuses that client on later calls', async () => {
    const first = await getSupabaseClient(config);
    const second = await getSupabaseClient(config);

    expect(second).toBe(first);
  });

  it('builds nothing at all when the backend is not configured', async () => {
    const client = await getSupabaseClient({ configured: false, url: null, anonKey: null });

    expect(client).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });
});
