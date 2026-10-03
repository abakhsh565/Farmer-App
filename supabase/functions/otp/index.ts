/**
 * Verification gateway: send and check a one-time code.
 *
 * Routes, after the function name:
 *
 *   POST /otp/request  { channel, destination }        → OtpRequest
 *   POST /otp/verify   { channel, destination, code }  → OtpVerifyResult
 *
 * The reply matches the client's `OtpProvider` contract exactly, including the
 * deliberate absence of `developmentCode`: a real provider never returns the code
 * to the client, and the type makes the "show me the code" affordance impossible
 * to ship against this implementation.
 *
 * Delivery is chosen from what is configured on the server, in this order:
 *
 *   1. `OTP_DELIVERY_URL` — a generic HTTP SMS/e-mail gateway. A farmer's app
 *      will eventually point this at a Pakistani SMS aggregator; the shape is a
 *      single POST with a bearer token, which every aggregator accepts.
 *   2. Supabase's own SMTP, for e-mail, when the project has it configured.
 *   3. Nothing. The code is generated, hashed and stored, and the send is
 *      reported as *not delivered* rather than silently pretending it went out.
 *
 * Case 3 is the important one. An app that says "code sent" when no message left
 * the building is an app whose users wait forever at a login screen.
 */

import { adminClient, callerOf, clean, fail, json, preflight, readJson, routeOf } from '../_shared/server.ts';
import {
  CODE_TTL_SECONDS,
  MAX_ATTEMPTS,
  MAX_SENDS_PER_HOUR,
  RESEND_SECONDS,
  constantTimeEqual,
  generateCode,
  hashCode,
  judge,
  normaliseDestination,
} from '../_shared/otp.ts';

const FUNCTION = 'otp';

type Channel = 'phone' | 'email';

/** The server secret used to key code hashes. Never the anon key. */
function hashSecret(): string | null {
  return Deno.env.get('OTP_HASH_SECRET') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? null;
}

/* -------------------------------------------------------------------------- */
/* Delivery                                                                   */
/* -------------------------------------------------------------------------- */

type Delivery = { delivered: boolean; via: string; detail?: string };

async function deliver(channel: Channel, destination: string, code: string): Promise<Delivery> {
  const gateway = Deno.env.get('OTP_DELIVERY_URL');

  if (gateway) {
    const token = Deno.env.get('OTP_DELIVERY_TOKEN') ?? '';
    const body =
      channel === 'phone'
        ? { to: destination, message: `Your Punjab Farmer verification code is ${code}. It expires in 5 minutes.` }
        : { to: destination, subject: 'Your verification code', message: `Your code is ${code}. It expires in 5 minutes.` };

    try {
      const response = await fetch(gateway, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      if (response.ok) {
        return { delivered: true, via: Deno.env.get('OTP_DELIVERY_NAME') ?? 'sms-gateway' };
      }
      return {
        delivered: false,
        via: 'sms-gateway',
        detail: `The gateway answered ${response.status}.`,
      };
    } catch (error) {
      return {
        delivered: false,
        via: 'sms-gateway',
        detail: error instanceof Error ? error.message : 'The gateway could not be reached.',
      };
    }
  }

  return {
    delivered: false,
    via: 'none',
    detail: 'No delivery provider is configured on the server, so no message was sent.',
  };
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                   */
/* -------------------------------------------------------------------------- */

async function handleRequest(body: Record<string, unknown>): Promise<Response> {
  const channel: Channel = body.channel === 'email' ? 'email' : 'phone';
  const raw = clean(body.destination, 120);
  if (!raw) return fail('A destination is required.');

  const destination = normaliseDestination(channel, raw);
  if (!destination) {
    return fail(
      channel === 'phone'
        ? 'That does not look like a Pakistani mobile number.'
        : 'That does not look like an email address.',
    );
  }

  const secret = hashSecret();
  if (!secret) return fail('The server is missing its code-signing secret.', 500);

  const client = adminClient();
  const now = Date.now();

  // Rate limits are enforced against stored sends, not against a client timer:
  // a timer the client owns is a timer the client can reset.
  const { data: recent, error: recentError } = await client
    .from('otp_challenges')
    .select('created_at')
    .eq('destination', destination)
    .gt('created_at', new Date(now - 60 * 60 * 1000).toISOString());

  if (recentError) return fail(`Could not check recent codes: ${recentError.message}`, 500);

  const sends = Array.isArray(recent) ? recent : [];
  if (sends.length >= MAX_SENDS_PER_HOUR) {
    return fail('Too many codes requested for this number. Try again in an hour.', 429);
  }

  const lastSent = sends
    .map((row) => Date.parse(String((row as { created_at?: string }).created_at ?? '')))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)[0];

  if (lastSent && now - lastSent < RESEND_SECONDS * 1000) {
    const wait = Math.ceil((RESEND_SECONDS * 1000 - (now - lastSent)) / 1000);
    return fail(`A code was just sent. Wait ${wait} seconds.`, 429);
  }

  const code = generateCode();
  const codeHash = await hashCode(code, destination, secret);
  const expiresAt = now + CODE_TTL_SECONDS * 1000;

  const caller = await callerOf(body['_req'] as Request ?? new Request('http://localhost'));

  // Any earlier live challenge is retired first, so only one code can ever work.
  await client
    .from('otp_challenges')
    .update({ consumed_at: new Date(now).toISOString() })
    .eq('destination', destination)
    .is('consumed_at', null);

  const { error: insertError } = await client.from('otp_challenges').insert({
    channel,
    destination,
    code_hash: codeHash,
    expires_at: new Date(expiresAt).toISOString(),
    attempts: 0,
    party_id: caller.userId,
  });

  if (insertError) return fail(`Could not store the code: ${insertError.message}`, 500);

  const delivery = await deliver(channel, destination, code);

  return json({
    channel,
    destination,
    deliveredVia: delivery.delivered ? delivery.via : `${delivery.via} (not delivered)`,
    expiresAt,
    resendAfterSeconds: RESEND_SECONDS,
    // Reported so the app can say "we could not send a message" instead of
    // leaving a farmer waiting for an SMS that will never arrive.
    ...(delivery.delivered ? {} : { deliveryError: delivery.detail ?? 'Delivery failed.' }),
  });
}

async function handleVerify(body: Record<string, unknown>): Promise<Response> {
  const channel: Channel = body.channel === 'email' ? 'email' : 'phone';
  const rawDestination = clean(body.destination, 120);
  const code = clean(body.code, 12);
  if (!rawDestination || !code) return fail('A destination and a code are required.');

  const destination = normaliseDestination(channel, rawDestination);
  if (!destination) return fail('That destination is not valid.');

  const secret = hashSecret();
  if (!secret) return fail('The server is missing its code-signing secret.', 500);

  const client = adminClient();
  const now = Date.now();

  const { data, error } = await client
    .from('otp_challenges')
    .select('id, code_hash, expires_at, attempts, consumed_at')
    .eq('destination', destination)
    .is('consumed_at', null)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) return fail(`Could not read the code: ${error.message}`, 500);

  const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
  if (!row) return json({ ok: false, reason: 'expired' });

  const attempts = typeof row.attempts === 'number' ? row.attempts : 0;
  const expiresAt = Date.parse(String(row.expires_at ?? ''));
  const storedHash = typeof row.code_hash === 'string' ? row.code_hash : '';

  const candidate = await hashCode(code, destination, secret);
  const matches = constantTimeEqual(candidate, storedHash);

  const verdict = judge({ attempts, expiresAt, now, matches });

  if (verdict !== 'ok') {
    // A wrong guess costs an attempt; an exhausted code is consumed immediately
    // so a fourth guess cannot be made at all.
    const next = verdict === 'mismatch' ? attempts + 1 : attempts;
    await client
      .from('otp_challenges')
      .update({
        attempts: next,
        ...(verdict === 'too_many_attempts' || next >= MAX_ATTEMPTS
          ? { consumed_at: new Date(now).toISOString() }
          : {}),
      })
      .eq('id', row.id);
    return json({ ok: false, reason: verdict });
  }

  await client
    .from('otp_challenges')
    .update({ consumed_at: new Date(now).toISOString(), attempts: attempts + 1 })
    .eq('id', row.id);

  return json({ ok: true });
}

/* -------------------------------------------------------------------------- */
/* Router                                                                     */
/* -------------------------------------------------------------------------- */

Deno.serve(async (req) => {
  const options = preflight(req);
  if (options) return options;

  if (req.method !== 'POST') return fail('Use POST.', 405);

  const route = routeOf(req, FUNCTION);
  const body = (await readJson<Record<string, unknown>>(req)) ?? {};
  // The caller is read from the JWT, not the body, and is stored with the
  // challenge so a signed-in request can be tied to the party it belongs to.
  body['_req'] = req;

  try {
    switch (route) {
      case 'request':
        return await handleRequest(body);
      case 'verify':
        return await handleVerify(body);
      default:
        return fail(`Unknown route "${route}".`, 404);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unexpected error';
    return fail(detail, 500);
  }
});
