/**
 * One-time code primitives.
 *
 * Two decisions are made here that a client-side implementation cannot make:
 *
 *   · The code is stored as a keyed hash, not as plaintext. A database dump
 *     therefore does not contain working login codes. The key is a server secret,
 *     so the hash cannot be recomputed from the dump alone.
 *   · The code is generated from a CSPRNG and compared in constant time. A code
 *     generated with `Math.random()` is guessable from a seed, and a comparison
 *     that returns early leaks the prefix through timing.
 *
 * Nothing here reads the clock or the database. It is pure, so it can be reasoned
 * about — and so the verification rules have exactly one definition.
 */

const DIGITS = 6;

/** Codes live for five minutes: long enough for an SMS, short enough to matter. */
export const CODE_TTL_SECONDS = 300;

/** Three attempts, then the code is burned. Guessing six digits is 1-in-10^6. */
export const MAX_ATTEMPTS = 3;

/** One send per destination per minute; five per hour. */
export const RESEND_SECONDS = 60;
export const MAX_SENDS_PER_HOUR = 5;

export function generateCode(): string {
  const bytes = new Uint8Array(DIGITS);
  crypto.getRandomValues(bytes);
  let code = '';
  for (const byte of bytes) {
    code += String(byte % 10);
  }
  // A code that begins with a zero is still six digits to a farmer reading it,
  // so the string is kept as-is rather than parsed as a number anywhere.
  return code;
}

export async function hashCode(code: string, destination: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  // The destination is part of the message, so a code cannot be replayed against
  // a different phone number even if two rows were somehow swapped.
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${destination}:${code}`));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Length-independent comparison, so a wrong code cannot be found digit by digit. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

/**
 * Normalises a destination.
 *
 * `03001234567`, `+923001234567` and `923001234567` are the same farmer, and an
 * app that treats them as three is an app where one person has three accounts and
 * a rate limit that never triggers. Pakistani numbers are normalised to the
 * international form without the plus.
 */
export function normaliseDestination(channel: 'phone' | 'email', raw: string): string | null {
  const value = raw.trim();

  if (channel === 'email') {
    const lower = value.toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(lower) ? lower : null;
  }

  const digits = value.replace(/[^\d]/g, '');
  if (digits.length === 0) return null;

  let national = digits;
  if (national.startsWith('92')) national = national.slice(2);
  if (national.startsWith('0')) national = national.slice(1);

  // Mobile numbers in Pakistan are ten digits beginning 3.
  if (!/^3\d{9}$/.test(national)) return null;
  return `92${national}`;
}

export type VerifyVerdict = 'ok' | 'expired' | 'mismatch' | 'too_many_attempts';

/** The rules, in the order that protects the code: exhausted, then expired, then wrong. */
export function judge(input: {
  attempts: number;
  expiresAt: number;
  now: number;
  matches: boolean;
}): VerifyVerdict {
  if (input.attempts >= MAX_ATTEMPTS) return 'too_many_attempts';
  if (input.now > input.expiresAt) return 'expired';
  if (!input.matches) return 'mismatch';
  return 'ok';
}
