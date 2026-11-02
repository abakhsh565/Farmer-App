/**
 * Verification through Supabase Auth — the provider that can actually mint a session.
 *
 * The app's own `otp` Edge Function verifies a code correctly and then stops: it
 * hashes codes, counts attempts and consumes them, but it issues no session, so
 * `auth.uid()` stays empty and every row-level policy in the database matches
 * nothing. A "signed-in" farmer would therefore own nothing. Supabase Auth is the
 * connected system that solves *that* half — it issues the access token the RLS
 * policies are written against — so this provider is what the app uses whenever a
 * backend is configured.
 *
 * What it deliberately does not do is hold the code. Supabase generates and sends
 * it; the client only ever posts what the farmer typed. Our own gateway remains
 * the provider for a deployment with no Supabase Auth configured, which is why the
 * class implements the same `OtpProvider` contract and nothing else had to change
 * in the screens.
 *
 * Two numbers here mirror the project's own configuration rather than being chosen
 * by this file: the code lives for `sms_otp_exp` and the resend cooldown is
 * `sms_max_frequency`. A client countdown that disagrees with the server is how a
 * farmer gets told "wrong code" for a code the server has already expired.
 */

import type { Identity, OtpChannel, OtpProvider, OtpRequest, OtpVerifyResult } from '../types';
import { serviceConfig } from '../config';
import { currentAuthUserId, getSupabaseClient, toE164 } from '../supabaseClient';

/** Mirrors `sms_otp_exp` on the project: 5 minutes. */
const OTP_TTL_SECONDS = 300;
/** Mirrors `sms_max_frequency` on the project: one send a minute. */
const RESEND_SECONDS = 60;

export class SupabaseOtpProvider implements OtpProvider {
  readonly name = 'Supabase Auth';
  readonly status = 'live' as const;

  private client() {
    return getSupabaseClient(serviceConfig.supabase);
  }

  async request(channel: OtpChannel, destination: string): Promise<OtpRequest> {
    const client = await this.client();
    if (!client) throw new Error('Supabase is not configured.');

    const now = Date.now();

    if (channel === 'phone') {
      const phone = toE164(destination);
      if (!phone) throw new Error('That does not look like a mobile number.');

      /*
       * `shouldCreateUser` is the honest setting for identity-on-action: reading
       * the app never creates an account, and asking for a code on a gated action
       * is exactly the moment the farmer has agreed to one. No password is set —
       * the phone is the credential.
       */
      const { error } = await client.auth.signInWithOtp({
        phone,
        options: { shouldCreateUser: true },
      });
      if (error) throw new Error(error.message);
    } else {
      const email = destination.trim().toLowerCase();
      const { error } = await client.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true, emailRedirectTo: undefined },
      });
      if (error) throw new Error(error.message);
    }

    return {
      channel,
      destination,
      deliveredVia: channel === 'phone' ? 'Supabase Auth (SMS)' : 'Supabase Auth (email)',
      expiresAt: now + OTP_TTL_SECONDS * 1000,
      resendAfterSeconds: RESEND_SECONDS,
      // No developmentCode: Supabase never returns the code to a client.
    };
  }

  async verify(channel: OtpChannel, destination: string, code: string): Promise<OtpVerifyResult> {
    const client = await this.client();
    if (!client) return { ok: false, reason: 'unknown' };

    const credential =
      channel === 'phone'
        ? { phone: toE164(destination), type: 'sms' as const }
        : { email: destination.trim().toLowerCase(), type: 'email' as const };

    const { data, error } = await client.auth.verifyOtp({ ...credential, token: code });

    if (error) {
      const message = error.message.toLowerCase();
      /*
       * Supabase collapses "wrong" and "expired" into one message, so the
       * distinction is made where it can actually be known: the screen checks its
       * own clock against the window it was given *before* calling this. Reaching
       * here with a bad token therefore means the code was wrong, which is a
       * different sentence and a different next action for the farmer.
       */
      if (message.includes('expired')) return { ok: false, reason: 'expired' };
      if (message.includes('too many') || message.includes('rate limit')) {
        return { ok: false, reason: 'too_many_attempts' };
      }
      return { ok: false, reason: 'mismatch' };
    }

    if (!data.session) return { ok: false, reason: 'unknown' };
    return { ok: true };
  }

  /**
   * Who the session belongs to, and the domain actor behind it.
   *
   * `ensure_party()` is idempotent and also the self-healing path: the database
   * trigger creates the party at signup, and this call covers an account that
   * predates the trigger or any provider that skipped it. It is not trusted for
   * authorisation — it returns the party id for a session Supabase has already
   * issued, and the database recomputes the same answer for every policy.
   */
  async identity(): Promise<Identity | null> {
    const client = await this.client();
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
