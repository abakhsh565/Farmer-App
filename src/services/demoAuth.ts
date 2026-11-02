/**
 * Demo sign-in: two fixed identities for walking the product end to end
 * without an SMS or email provider.
 *
 * WHY THIS EXISTS
 *
 * Every accountable action in the app is gated behind a session, and a session is
 * only useful if the database recognises it: every row-level policy matches on
 * `auth.uid()`, so a farmer who is "signed in" locally but holds no access token
 * owns nothing and sees an empty app. Twilio delivery is not working on this
 * project, so there was no way to obtain such a token. This module is the way:
 * it signs in to two accounts that already exist in the project, using
 * `signInWithPassword` on the Supabase client.
 *
 * That is genuine authentication, not a bypass. The password check happens on
 * the server, the token that comes back is a real one, and every policy is
 * enforced exactly as it is for a production farmer. What makes it a *demo* is
 * only that the code is fixed and displayed on screen instead of being sent.
 *
 * WHERE THE CREDENTIAL LIVES
 *
 * It is read from `VITE_DEMO_FARMERS` behind `import.meta.env.DEV`, and it is
 * deliberately NOT part of `ServiceConfig`. `config.ts` carries a standing rule
 * that anything in it must be safe to publish on a billboard; a demo password is
 * not. Keeping it out of that object is what stops it reaching a production
 * bundle by accident.
 *
 * `import.meta.env.DEV` is `false` in every `vite build`, so in a production
 * bundle `demoAuth()` returns null before it ever touches the value. The tests
 * pin the variable to empty (`vite.config.ts`, `test.env`) so a developer's own
 * `.env.local` cannot quietly change what the suite runs against.
 *
 * WHY TWO IDENTITIES AND NOT TWO NEW ACCOUNTS
 *
 * Signing in must resolve to the *same* farmer every time — same `auth.users`
 * row, same party, same documents. So this signs in to accounts that were created
 * once, by the project owner, and never creates one. `shouldCreateUser` is
 * deliberately absent for the same reason.
 */

import type { OtpChannel } from './types';

export type DemoIdentity = {
  /** Shown nowhere in the product; for the person configuring the demo. */
  name: string;
  channel: OtpChannel;
  /** Normalised the way the app compares destinations: digits, or lowercased. */
  destination: string;
  /**
   * The code the sheet displays, and the account's credential.
   *
   * One field rather than two on purpose. A separate password would be a second
   * secret with no added protection — both would ship in the same dev-only
   * variable — and two fields that must agree is one more way to configure it
   * wrong. It is used verbatim as the password, which is why it is checked
   * against the server rather than merely compared here.
   */
  code: string;
};

export type DemoAuthConfig = { identities: readonly DemoIdentity[] };

/**
 * The same shapes the identity sheet accepts, applied here so a misconfigured
 * identity fails loudly at parse time instead of at the sheet, where it would
 * look to the farmer like their own typing was wrong.
 */
const PHONE = /^03\d{9}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CODE = /^\d{6}$/;
const MAX_NAME = 120;

/** How a destination is compared: the app's own normalisation, not a second one. */
export function normalizeDestination(channel: OtpChannel, value: string): string {
  return channel === 'phone' ? value.replace(/[^0-9]/g, '') : value.trim().toLowerCase();
}

/**
 * Reads the configured identities, dropping anything that is not usable.
 *
 * Strict by design. A malformed entry is a credential mistake, and the honest
 * answers are "that identity is not configured" or "that entry is not valid" —
 * never an account that signs in with something other than what the sheet
 * displayed. Returns null when nothing valid remains, which is what leaves the
 * app on its ordinary providers.
 */
export function parseDemoIdentities(raw: unknown): DemoAuthConfig | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text === '') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  // Both shapes are accepted so the variable can grow a wrapper later without a
  // breaking change: a bare array, or `{ "identities": [...] }`.
  const entries = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' &&
        parsed !== null &&
        Array.isArray((parsed as { identities?: unknown }).identities)
      ? ((parsed as { identities: unknown[] }).identities as unknown[])
      : null;
  if (!entries) return null;

  const identities: DemoIdentity[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { name, channel, destination, code } = entry as Record<string, unknown>;

    if (typeof name !== 'string') continue;
    const trimmedName = name.trim();
    if (trimmedName === '' || trimmedName.length > MAX_NAME) continue;

    if (channel !== 'phone' && channel !== 'email') continue;
    if (typeof destination !== 'string') continue;
    if (typeof code !== 'string' || !CODE.test(code)) continue;

    const normalized = normalizeDestination(channel, destination);
    if (channel === 'phone' ? !PHONE.test(normalized) : !EMAIL.test(normalized)) continue;

    /*
     * Two identities claiming one destination would make which account you get
     * depend on array order — the same number signing in as a different farmer
     * depending on how the variable was edited. The first is kept and the rest
     * dropped, so the mapping stays one destination → one account.
     */
    const key = `${channel}:${normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);

    identities.push({ name: trimmedName, channel, destination: normalized, code });
  }

  return identities.length > 0 ? { identities } : null;
}

/** The configured identity for a typed destination, if there is one. */
export function findDemoIdentity(
  config: DemoAuthConfig,
  channel: OtpChannel,
  destination: string,
): DemoIdentity | undefined {
  const normalized = normalizeDestination(channel, destination);
  return config.identities.find(
    (identity) => identity.channel === channel && identity.destination === normalized,
  );
}

/**
 * The demo identities for this build, or null.
 *
 * `import.meta.env.DEV` is a compile-time constant: `vite build` inlines it as
 * `false`, which makes the read below unreachable and lets the bundler drop it.
 * A production build therefore contains no demo configuration and cannot select
 * the demo provider, whatever a deployment's environment happens to hold.
 */
export function demoAuth(): DemoAuthConfig | null {
  if (!import.meta.env.DEV) return null;
  return parseDemoIdentities(import.meta.env.VITE_DEMO_FARMERS);
}
