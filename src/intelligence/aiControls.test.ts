import { describe, expect, it, vi } from 'vitest';
import {
  claimAiRequest,
  finishAiRequest,
  recordAiFeedback,
} from '../../supabase/functions/_shared/aiControls';

type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { message: string } | null;
}>;

function client(reply: unknown, error: { message: string } | null = null) {
  const rpc = vi.fn<Rpc>(async () => ({ data: reply, error }));
  return { rpc };
}

describe('AI request controls', () => {
  it('claims with no farmer id in the arguments', async () => {
    const fake = client({ allowed: true, duplicate: false, retry_after_seconds: null, event_id: 'event-1' });
    const claim = await claimAiRequest(fake, 'ask', 'request-123');

    expect(claim).toEqual({
      ok: true,
      allowed: true,
      eventId: 'event-1',
      duplicate: false,
      retryAfterSeconds: null,
    });
    expect(fake.rpc).toHaveBeenCalledWith('ai_claim_request', {
      p_route: 'ask',
      p_request_id: 'request-123',
    });
    expect(fake.rpc.mock.calls[0]?.[1]).not.toHaveProperty('p_party_id');
  });

  it('reports a duplicate without treating it as an allowed request', async () => {
    const fake = client({ allowed: false, duplicate: true, retry_after_seconds: null, event_id: 'event-1' });
    await expect(claimAiRequest(fake, 'ask', 'request-123')).resolves.toMatchObject({
      ok: true,
      allowed: false,
      duplicate: true,
    });
  });

  it('reports the server retry window on a rate limit', async () => {
    const fake = client({ allowed: false, duplicate: false, retry_after_seconds: 42, event_id: 'event-2' });
    await expect(claimAiRequest(fake, 'diagnose', null)).resolves.toMatchObject({
      ok: true,
      allowed: false,
      retryAfterSeconds: 42,
    });
  });

  it('fails closed when the control RPC is unavailable', async () => {
    const fake = client(null, { message: 'unavailable' });
    await expect(claimAiRequest(fake, 'ask', null)).resolves.toEqual({ ok: false });
  });

  it('records operational metadata only on finish', async () => {
    const fake = client(true);
    await finishAiRequest(fake, 'event-1', {
      outcome: 'fallback',
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      latencyMs: 123,
      evidenceCount: 2,
      citationCount: 3,
      errorCode: 'provider_rate_limited',
    });

    const [, args] = fake.rpc.mock.calls[0]!;
    expect(args).toMatchObject({
      p_event_id: 'event-1',
      p_outcome: 'fallback',
      p_provider: 'gemini',
      p_model: 'gemini-3.8-flash',
      p_latency_ms: 123,
      p_evidence_count: 2,
      p_citation_count: 3,
      p_error_code: 'provider_rate_limited',
    });
    expect(args).not.toHaveProperty('p_question');
    expect(args).not.toHaveProperty('p_farmer_id');
  });

  it('submits bounded feedback under the request id', async () => {
    const fake = client(true);
    await expect(recordAiFeedback(fake, 'request-123', true, 'incorrect')).resolves.toBe(true);
    expect(fake.rpc).toHaveBeenCalledWith('ai_feedback', {
      p_request_id: 'request-123',
      p_helpful: true,
      p_reason: 'incorrect',
    });
  });
});
