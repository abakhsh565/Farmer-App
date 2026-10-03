/**
 * OTP verification, as a pure state machine.
 *
 * Kept out of the component on purpose. The brief asks for the complete flow —
 * request, verification state, retry, expiry, invalid code, session creation —
 * and every one of those is a transition, which means the only way to be sure
 * they all work is to make them testable without a phone or a network.
 *
 * The rules encoded here are the ones a real provider will honour, so behaviour
 * does not change when the development provider is replaced:
 *
 *   · a resend inside the cooldown is refused rather than silently sending a
 *     second code, because two valid codes is how a user enters the wrong one
 *   · an expired code is terminal for that code; the only way on is to request
 *     another, and the UI must say so rather than showing "wrong code"
 *   · attempts are counted, so a code cannot be brute-forced
 *   · success is terminal: a verified code is consumed
 */

import type { MessageKey } from '../i18n/catalog';
import type { OtpChannel } from './types';

export type OtpPhase =
  | 'idle'
  | 'sending'
  | 'awaiting_code'
  | 'verifying'
  | 'verified'
  | 'failed';

export type OtpError = 'mismatch' | 'expired' | 'too_many_attempts' | 'network' | 'cooldown' | 'unknown';

export type OtpState = {
  phase: OtpPhase;
  channel: OtpChannel;
  /** Normalised destination being verified. */
  destination: string;
  attempts: number;
  /** Wall clock at which the entered code stops being valid. */
  expiresAt: number | null;
  /** Wall clock before which another send will be refused. */
  resendAllowedAt: number | null;
  error: OtpError | null;
  /**
   * Development only — populated by the development provider so a tester can
   * complete the flow on a device with no SMS. The production provider leaves it
   * undefined, and the screen must treat absence as normal.
   */
  developmentCode: string | null;
};

export function initialOtpState(channel: OtpChannel = 'phone', destination = ''): OtpState {
  return {
    phase: 'idle',
    channel,
    destination,
    attempts: 0,
    expiresAt: null,
    resendAllowedAt: null,
    error: null,
    developmentCode: null,
  };
}

export function requestStarted(state: OtpState): OtpState {
  return { ...state, phase: 'sending', error: null };
}

export function codeSent(
  state: OtpState,
  sent: { expiresAt: number; resendAfterSeconds: number; developmentCode?: string },
  now: number,
): OtpState {
  return {
    ...state,
    phase: 'awaiting_code',
    attempts: 0,
    expiresAt: sent.expiresAt,
    resendAllowedAt: now + sent.resendAfterSeconds * 1000,
    error: null,
    developmentCode: sent.developmentCode ?? null,
  };
}

/**
 * A send that never reached the provider.
 *
 * The phase goes to 'failed' rather than back to a code step that is waiting for
 * a code nobody was sent: the farmer's next action is to try the send again, and
 * the screen can only offer that if it knows no code exists yet.
 */
export function requestFailed(state: OtpState, error: OtpError = 'network'): OtpState {
  return { ...state, phase: 'failed', error, expiresAt: null, developmentCode: null };
}

export function verifyStarted(state: OtpState): OtpState {
  return { ...state, phase: 'verifying', error: null };
}

export function verifySucceeded(state: OtpState): OtpState {
  return { ...state, phase: 'verified', error: null, expiresAt: null, developmentCode: null };
}

export function verifyFailed(state: OtpState, error: OtpError): OtpState {
  // An expired or exhausted code cannot be retried; the machine returns to a
  // state whose only exit is a new request.
  const terminal = error === 'expired' || error === 'too_many_attempts';
  return {
    ...state,
    phase: 'awaiting_code',
    attempts: state.attempts + 1,
    error,
    expiresAt: terminal ? null : state.expiresAt,
  };
}

/** Whether the resend control should be live. */
export function canResend(state: OtpState, now: number): boolean {
  if (state.phase !== 'awaiting_code' && state.phase !== 'failed') return false;
  if (state.resendAllowedAt === null) return true;
  return now >= state.resendAllowedAt;
}

/** Seconds to show on a disabled resend control, or 0 when it is live. */
export function secondsUntilResend(state: OtpState, now: number): number {
  if (state.resendAllowedAt === null) return 0;
  return Math.max(0, Math.ceil((state.resendAllowedAt - now) / 1000));
}

/** True once the entered code has no time left, regardless of what was typed. */
export function hasExpired(state: OtpState, now: number): boolean {
  return state.expiresAt !== null && now > state.expiresAt;
}

export function resetOtpState(state: OtpState): OtpState {
  return initialOtpState(state.channel, state.destination);
}

/**
 * The sentence the screen should show for a failure.
 *
 * Each reason gets its own wording. Collapsing these into one "try again" would
 * be easier and worse: a farmer whose code expired would be told the code was
 * wrong, and would re-read six digits looking for a mistake that is not there.
 */
export function otpErrorKey(error: OtpError): MessageKey {
  switch (error) {
    case 'expired':
      return 'otp.expired';
    case 'too_many_attempts':
      return 'otp.tooManyAttempts';
    case 'mismatch':
      return 'otp.mismatch';
    case 'network':
      return 'otp.network';
    case 'cooldown':
      // Not a failure the user needs to fix: the cooldown is visible on the
      // resend control itself, so reaching here means a racing double-tap.
      return 'otp.resend';
    default:
      return 'otp.network';
  }
}
