/**
 * The demo verification provider: a code that does not need to be sent, over a
 * session that is genuinely issued.
 *
 * It implements the same `OtpProvider` contract as every other provider, so the
 * identity sheet, the flow machine and the screens are untouched — the sheet
 * already renders `developmentCode` when a provider returns one, and that is the
 * whole of the UI change this needs.
 *
 * THE ONE THING WORTH BEING CAREFUL ABOUT
 *
 * The demo code and the account's password are the same value, and the code is
 * compared here as well as on the server. That local comparison is a courtesy,
 * not a security boundary: a client that skipped it would still have to satisfy
 * Supabase's password check, so tampering with the app cannot produce a session.
 * The real boundary is `signInWithPassword`, and it is the server's.
 *
 * `status` is `development` rather than `live` on purpose. It signs in for real,
 * but it is not the path a production farmer takes, and the diagnostics surface
 * must not describe it as the live one.
 */

import type { Identity, OtpChannel, OtpProvider, OtpRequest, OtpVerifyResult } from '../types';
import { serviceConfig } from '../config';
import {
  currentAuthUserId,
  getSupabaseClient,
  toE164,
  type SupabaseLike,
} from '../supabaseClient';
import { findDemoIdentity, type DemoAuthConfig } from '../demoAuth';

/** The same window the live provider reports, so countdowns behave identically. */
const OTP_TTL_SECONDS = 300;
/** The same reset cooldown as the live provider. */
const RESEND_SECONDS = 60;

/** Injectable so the provider can be tested without a configured backend. */
type ClientFactory = () => Promise<SupabaseLike | null>;

export class DemoOtpProvider implements OtpProvider {
  readonly name = 'Demo sign-in';
  readonly status = 'development' as const;

  constructor(
    private readonly config: DemoAuthConfig,
    private readonly clientFactory: ClientFactory = () =>
      getSupabaseClient(serviceConfig.supabase),
  ) {}

  /**
   * Issues the configured code for a configured identity, and sends nothing.
   *
   * No network call at all: the point of this provider is to work when delivery
   * does not. An unrecognised destination is refused rather than silently
   * accepted, because "any number works" would make this a bypass rather than a
   * demo.
   */
  async request(channel: OtpChannel, destination: string): Promise<OtpRequest> {
    const identity = findDemoIdentity(this.config, channel, destination);
    if (!identity) {
      throw new Error(
        'That is not one of the demo accounts configured for this build, so no code was issued. ' +
          'Use one of the demo numbers or addresses.',
      );
    }

    const now = Date.now();
    return {
      channel,
      destination: identity.destination,
      deliveredVia: 'demo (shown on screen)',
      expiresAt: now + OTP_TTL_SECONDS * 1000,
      resendAfterSeconds: RESEND_SECONDS,
      // The sheet renders this as a development hint. It is the same value the
      // account's password check uses, which is what makes one code enough.
      developmentCode: identity.code,
    };
  }

  /**
   * Verifies the code by signing in with it.
   *
   * The session this returns is a real one — `access_token`, `auth.uid()`, and
   * every policy in the database applies to it. That is why `identity()` below is
   * implemented: there is a server-recognised actor to report.
   */
  async verify(
    channel: OtpChannel,
    destination: string,
    code: string,
  ): Promise<OtpVerifyResult> {
    const identity = findDemoIdentity(this.config, channel, destination);
    // An unconfigured destination and a wrong code are the same answer here:
    // neither is a valid credential, and the sheet already knows which contact
    // was typed.
    if (!identity) return { ok: false, reason: 'mismatch' };
    if (code !== identity.code) return { ok: false, reason: 'mismatch' };

    const client = await this.clientFactory();
    if (!client) return { ok: false, reason: 'unknown' };

    const credential =
      channel === 'phone'
        ? { phone: toE164(identity.destination), password: identity.code }
        : { email: identity.destination, password: identity.code };

    const { data, error } = await client.auth.signInWithPassword(credential);

    /*
     * Any refusal — a wrong or rotated password, a deleted account, a disabled
     * sign-in — arrives as one answer, because the sheet has one sentence for it
     * and a farmer cannot act on the difference. The message is deliberately not
     * surfaced: it is the server's words about credentials, and the sheet already
     * says what the farmer should do.
     */
    if (error) return { ok: false, reason: 'mismatch' };
    if (!data.session) return { ok: false, reason: 'unknown' };

    return { ok: true };
  }

  /**
   * The party behind the session, exactly as the live provider asks for it.
   *
   * `ensure_party()` is idempotent and is the self-healing path: the trigger
   * creates the party with the account, and this covers an account that predates
   * the trigger. It is not trusted for authorisation — it returns the party id for
   * a session Supabase has already issued, and the database recomputes the same
   * answer for every policy.
   */
  async identity(): Promise<Identity | null> {
    const client = await this.clientFactory();
    if (!client) return null;

    const authUserId = await currentAuthUserId();
    if (!authUserId) return null;

    const { data, error } = await client.rpc('ensure_party');
    if (error) return { partyId: null, authUserId, displayName: null };

    return {
      partyId: typeof data === 'string' ? data : null,
      authUserId,
      displayName: null,
    };
  }
}
