/**
 * The client's half of the Edge Function contract.
 *
 * The functions cannot be executed in this environment — there is no Deno runtime
 * and no deployed project — so the thing that *can* be checked is the part that
 * actually breaks in practice: the request the app builds. A route spelled
 * `/ask` in one file and `/Ask` in the other, a body field renamed on one side,
 * an endpoint with a trailing slash producing `//ask`: all of those fail at
 * runtime, on a farmer's phone, and none of them are visible from a typecheck.
 *
 * So these tests assert the URL and the body against a stubbed `fetch`, and they
 * assert that what the server replies is passed through unchanged. The server's
 * own behaviour is checked separately by `scripts/check-functions.mjs`, which
 * reads the function sources and refuses a route the client cannot reach.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteAiProvider, RemoteOtpProvider } from './providers/remote';

const AI = 'https://project.supabase.co/functions/v1/ai';
const OTP = 'https://project.supabase.co/functions/v1/otp';

type Call = { url: string; body: Record<string, unknown>; method: string };

/** Records what was sent, and answers with whatever the test needs. */
function stubFetch(reply: unknown, status = 200): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => reply,
    } as Response;
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AI gateway contract', () => {
  it('posts a question to the function\'s ask route', async () => {
    const calls = stubFetch({
      gate: 'agriculture',
      confidence: 81,
      text: 'Sow in the window.',
      citations: [{ kind: 'knowledge', label: 'agronomy', version: 2 }],
      escalate: false,
      caveats: [],
    });

    const provider = new RemoteAiProvider(AI);
    const answer = await provider.ask('when should I sow wheat', {
      language: 'en',
      cropCode: 'wheat',
      weatherUsable: true,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${AI}/ask`);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body.question).toBe('when should I sow wheat');
    // The context travels with the question: the server needs the crop to
    // retrieve the right entries, and cannot invent it.
    expect((calls[0]?.body.context as Record<string, unknown>).cropCode).toBe('wheat');

    // The reply is the server's, untouched. The provider must not "improve" it.
    expect(answer.gate).toBe('agriculture');
    expect(answer.confidence).toBe(81);
    expect(answer.citations[0]?.version).toBe(2);
  });

  it('does not produce a double slash when the endpoint has a trailing one', async () => {
    const calls = stubFetch({ gate: 'not_covered', confidence: 20, citations: [], escalate: true, caveats: [] });
    await new RemoteAiProvider(`${AI}/`).ask('anything', { language: 'en' });
    expect(calls[0]?.url).toBe(`${AI}/ask`);
  });

  it('posts an image to the diagnose route', async () => {
    const calls = stubFetch({
      gate: 'agriculture',
      diagnosis: 'Pink bollworm',
      confidence: 74,
      uncertaintyKey: null,
      citations: [],
      escalate: false,
    });

    const result = await new RemoteAiProvider(AI).diagnose('data:image/png;base64,AAAA', {
      language: 'ur',
      cropCode: 'cotton',
      cropStage: 'flowering',
    });

    expect(calls[0]?.url).toBe(`${AI}/diagnose`);
    expect(calls[0]?.body.imageRef).toBe('data:image/png;base64,AAAA');
    expect(result.diagnosis).toBe('Pink bollworm');
  });

  it('surfaces a server refusal as an error rather than an empty answer', async () => {
    stubFetch({ error: 'The model is not configured on the server.' }, 503);
    await expect(new RemoteAiProvider(AI).ask('hello', { language: 'en' })).rejects.toThrow(
      /503/,
    );
  });

  it('throws rather than calling anything when no endpoint is configured', async () => {
    const calls = stubFetch({});
    await expect(new RemoteAiProvider(null).ask('hello', { language: 'en' })).rejects.toThrow(
      /not configured/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('OTP gateway contract', () => {
  it('posts a request to the request route and returns the server\'s window', async () => {
    const calls = stubFetch({
      channel: 'phone',
      destination: '923001234567',
      deliveredVia: 'sms-gateway',
      expiresAt: 1_760_000_000_000,
      resendAfterSeconds: 60,
    });

    const request = await new RemoteOtpProvider(OTP).request('phone', '03001234567');

    expect(calls[0]?.url).toBe(`${OTP}/request`);
    expect(calls[0]?.body).toMatchObject({ channel: 'phone', destination: '03001234567' });
    expect(request.resendAfterSeconds).toBe(60);
    /*
     * The remote provider must never carry a code back to the client. The
     * development provider does, behind an optional field, so that a screen can
     * render it in a test — and this assertion is what keeps that affordance from
     * being copied into the live path.
     */
    expect(request.developmentCode).toBeUndefined();
  });

  it('posts a code to the verify route and passes the verdict through', async () => {
    const calls = stubFetch({ ok: false, reason: 'too_many_attempts' });

    const result = await new RemoteOtpProvider(OTP).verify('phone', '03001234567', '123456');

    expect(calls[0]?.url).toBe(`${OTP}/verify`);
    expect(calls[0]?.body).toMatchObject({ channel: 'phone', code: '123456' });
    expect(result).toEqual({ ok: false, reason: 'too_many_attempts' });
  });

  it('reports the server\'s own words when it refuses a send', async () => {
    // A rate limit is the server's decision, and "wait 40 seconds" is the part
    // the farmer can act on. Replacing it with a status code loses that.
    stubFetch({ error: 'A code was just sent. Wait 40 seconds.' }, 429);
    await expect(new RemoteOtpProvider(OTP).request('phone', '03001234567')).rejects.toThrow(
      /Wait 40 seconds/,
    );
  });
});
