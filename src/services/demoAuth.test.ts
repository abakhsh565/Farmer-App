import { describe, expect, it, vi } from 'vitest';
import {
  demoAuth,
  findDemoIdentity,
  normalizeDestination,
  parseDemoIdentities,
  type DemoAuthConfig,
} from './demoAuth';
import { DemoOtpProvider } from './providers/demoAuth';
import { SupabaseOtpProvider } from './providers/supabaseAuth';
import { createServices, serviceSummary } from './registry';
import { configurationReport, resolveProviders, type ServiceConfig } from './config';
import type { SupabaseLike } from './supabaseClient';

/**
 * Demo sign-in, and the boundary that keeps it out of production.
 *
 * The valuable assertions here are not the happy path — they are the refusals.
 * A demo provider that accepted any number, or that fell back to a local session
 * when the server said no, would look identical on screen and would be a login
 * bypass. So: an unconfigured destination is refused, a wrong code never reaches
 * the network, a server refusal is never converted into success, and the provider
 * cannot be selected when the demo configuration is absent.
 */

const FARMER_A = { name: 'Demo Farmer A', phone: '03000000001', code: '111111' };
const FARMER_B = { name: 'Demo Farmer B', email: 'demo.b@example.com', code: '222222' };

const RAW = JSON.stringify([
  { name: FARMER_A.name, channel: 'phone', destination: FARMER_A.phone, code: FARMER_A.code },
  { name: FARMER_B.name, channel: 'email', destination: FARMER_B.email, code: FARMER_B.code },
]);

const CONFIG: DemoAuthConfig = parseDemoIdentities(RAW) as DemoAuthConfig;

const BACKEND: ServiceConfig = {
  supabase: { url: 'https://project.supabase.co', anonKey: 'anon', configured: true },
  aiEndpoint: { url: null, configured: false },
  otpEndpoint: { url: null, configured: false },
  dealerEndpoint: { url: null, configured: false },
  weatherIngestEndpoint: { url: null, configured: false },
  analytics: { key: null, host: 'https://eu.i.posthog.com', configured: false },
  weather: { provider: 'supabase' },
};

/** A client that records what it was asked to do, and answers as told. */
function stubClient(response: {
  error?: { message: string } | null;
  session?: unknown;
} = {}) {
  const signInWithPassword = vi.fn(async () => ({
    data: { session: response.session ?? { access_token: 'token' }, user: { id: 'auth-a' } },
    error: response.error ?? null,
  }));
  const rpc = vi.fn(async () => ({ data: 'party-a', error: null }));
  return { client: { auth: { signInWithPassword }, rpc } as unknown as SupabaseLike, signInWithPassword };
}

/* -------------------------------------------------------------------------- */

describe('demo configuration', () => {
  it('reads both identities and normalises the destinations it compares', () => {
    expect(CONFIG.identities).toHaveLength(2);
    expect(CONFIG.identities[0]).toMatchObject({ name: 'Demo Farmer A', destination: '03000000001' });
    expect(CONFIG.identities[1]).toMatchObject({ name: 'Demo Farmer B', destination: 'demo.b@example.com' });
  });

  it('accepts a wrapper object, so the variable can grow without breaking', () => {
    const wrapped = parseDemoIdentities(JSON.stringify({ identities: JSON.parse(RAW) }));
    expect(wrapped?.identities).toHaveLength(2);
  });

  it('refuses anything that is not a usable list of identities', () => {
    for (const raw of [undefined, null, '', '   ', 'not json', '{}', '[]', '{"identities":"x"}', 42]) {
      expect(parseDemoIdentities(raw)).toBeNull();
    }
  });

  it('drops entries that could never be typed into the sheet', () => {
    const parsed = parseDemoIdentities(
      JSON.stringify([
        // Not a Pakistani mobile number, so the sheet's own validation would
        // reject it and the farmer would think their typing was wrong.
        { name: 'Bad phone', channel: 'phone', destination: '12345', code: '111111' },
        { name: 'Not an email', channel: 'email', destination: 'nope', code: '111111' },
        { name: 'Short code', channel: 'phone', destination: '03000000009', code: '12' },
        // No name at all, and a blank one — neither is an identity we can show.
        { channel: 'phone', destination: '03000000008', code: '123456' },
        { name: '   ', channel: 'phone', destination: '03000000005', code: '123456' },
        { name: 'Unknown channel', channel: 'sms', destination: '03000000007', code: '123456' },
        { name: 'Good', channel: 'phone', destination: '03000000006', code: '123456' },
      ]),
    );
    expect(parsed?.identities).toHaveLength(1);
    expect(parsed?.identities[0]?.name).toBe('Good');
  });

  it('keeps the first of two identities claiming one destination', () => {
    // Otherwise which farmer you become would depend on array order.
    const parsed = parseDemoIdentities(
      JSON.stringify([
        { name: 'First', channel: 'phone', destination: '03000000001', code: '111111' },
        { name: 'Second', channel: 'phone', destination: '0300 0000001', code: '222222' },
      ]),
    );
    expect(parsed?.identities).toHaveLength(1);
    expect(parsed?.identities[0]?.name).toBe('First');
  });

  it('matches a typed destination regardless of how it was typed', () => {
    expect(findDemoIdentity(CONFIG, 'phone', '0300 0000001')?.name).toBe(FARMER_A.name);
    expect(findDemoIdentity(CONFIG, 'phone', '0300-0000001')?.name).toBe(FARMER_A.name);
    expect(findDemoIdentity(CONFIG, 'email', 'DEMO.B@Example.COM')?.name).toBe(FARMER_B.name);
    // The wrong channel is not a match, even with the same digits.
    expect(findDemoIdentity(CONFIG, 'email', FARMER_A.phone)).toBeUndefined();
    expect(findDemoIdentity(CONFIG, 'phone', '03009999999')).toBeUndefined();
  });

  it('normalises the two ways the app compares a destination', () => {
    expect(normalizeDestination('phone', '+92 300-000 0001')).toBe('923000000001');
    expect(normalizeDestination('email', ' Demo.B@Example.com ')).toBe('demo.b@example.com');
  });
});

/* -------------------------------------------------------------------------- */

describe('demo provider', () => {
  it('issues the configured code without sending anything', async () => {
    const { client, signInWithPassword } = stubClient();
    const provider = new DemoOtpProvider(CONFIG, async () => client);

    const request = await provider.request('phone', '0300 0000001');

    expect(request.developmentCode).toBe(FARMER_A.code);
    expect(request.destination).toBe('03000000001');
    expect(request.resendAfterSeconds).toBeGreaterThan(0);
    // Asking for a code must not authenticate, and must not touch the network.
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it('refuses a destination that is not a configured demo account', async () => {
    const provider = new DemoOtpProvider(CONFIG, async () => stubClient().client);
    // "Any number works" would make this a bypass rather than a demo.
    await expect(provider.request('phone', '03007654321')).rejects.toThrow(/demo accounts/i);
    await expect(provider.request('email', 'stranger@example.com')).rejects.toThrow(/demo accounts/i);
  });

  it('rejects a wrong code without asking the server', async () => {
    const { client, signInWithPassword } = stubClient();
    const provider = new DemoOtpProvider(CONFIG, async () => client);

    const result = await provider.verify('phone', '03000000001', '999999');

    expect(result).toEqual({ ok: false, reason: 'mismatch' });
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it('rejects an unconfigured destination instead of falling back to a local session', async () => {
    const { client, signInWithPassword } = stubClient();
    const provider = new DemoOtpProvider(CONFIG, async () => client);

    const result = await provider.verify('email', 'stranger@example.com', FARMER_B.code);

    expect(result).toEqual({ ok: false, reason: 'mismatch' });
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it('signs in with a real credential for the right code', async () => {
    const { client, signInWithPassword } = stubClient();
    const provider = new DemoOtpProvider(CONFIG, async () => client);

    expect(await provider.verify('phone', '0300 0000001', FARMER_A.code)).toEqual({ ok: true });
    // The session is Supabase's, so the password goes to Supabase in E.164.
    expect(signInWithPassword).toHaveBeenCalledWith({
      phone: '+923000000001',
      password: FARMER_A.code,
    });

    expect(await provider.verify('email', 'DEMO.B@Example.com', FARMER_B.code)).toEqual({ ok: true });
    expect(signInWithPassword).toHaveBeenLastCalledWith({
      email: 'demo.b@example.com',
      password: FARMER_B.code,
    });
  });

  it('never turns a server refusal into a session', async () => {
    const { client } = stubClient({ error: { message: 'Invalid login credentials' } });
    const provider = new DemoOtpProvider(CONFIG, async () => client);

    expect(await provider.verify('phone', '03000000001', FARMER_A.code)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('reports unknown when the server returns no session', async () => {
    const signInWithPassword = vi.fn(async () => ({ data: { session: null, user: null }, error: null }));
    const client = { auth: { signInWithPassword }, rpc: vi.fn() } as unknown as SupabaseLike;
    const provider = new DemoOtpProvider(CONFIG, async () => client);

    expect(await provider.verify('phone', '03000000001', FARMER_A.code)).toEqual({
      ok: false,
      reason: 'unknown',
    });
  });

  it('reports unknown rather than fabricating an identity when there is no client', async () => {
    const provider = new DemoOtpProvider(CONFIG, async () => null);

    expect(await provider.verify('phone', '03000000001', FARMER_A.code)).toEqual({
      ok: false,
      reason: 'unknown',
    });
    // No cached session in the suite, so there is nobody to report — and
    // returning a made-up party id here is exactly what must not happen.
    expect(await provider.identity()).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe('the production boundary', () => {
  it('is not configured in this suite, because the variable is pinned empty', () => {
    // `vite.config.ts` pins VITE_DEMO_FARMERS so a developer's `.env.local`
    // cannot change which app the suite runs against.
    expect(demoAuth()).toBeNull();
  });

  it('resolves to Supabase, never demo, when no demo configuration is present', () => {
    // The production shape: a backend, no demo identities.
    expect(resolveProviders(BACKEND, false).otp).toBe('supabase');
    expect(createServices(BACKEND, null).otp).toBeInstanceOf(SupabaseOtpProvider);
  });

  it('resolves to demo only when the configuration is supplied', () => {
    expect(resolveProviders(BACKEND, true).otp).toBe('demo');
    const services = createServices(BACKEND, CONFIG);
    expect(services.otp).toBeInstanceOf(DemoOtpProvider);
    expect(services.otp.name).toBe('Demo sign-in');
    // It signs in for real, but it must not be advertised as the live path
    // because no code is delivered.
    expect(services.otp.status).toBe('development');
  });

  it('leaves the rest of the stack untouched when demo sign-in is on', () => {
    const plain = createServices(BACKEND, null);
    const demo = createServices(BACKEND, CONFIG);

    expect(demo.repository).toBeInstanceOf(plain.repository.constructor);
    expect(demo.dealer).toBeInstanceOf(plain.dealer.constructor);
    expect(demo.market).toBeInstanceOf(plain.market.constructor);
  });

  it('tells the diagnostics panel the code is not being delivered', () => {
    const row = configurationReport(BACKEND, true).find((entry) => entry.service === 'otp');
    expect(row?.mode).toBe('development');

    // And describes whichever services it is actually given, not the default.
    expect(serviceSummary(createServices(BACKEND, CONFIG))).toContain('otp: development');
  });
});
