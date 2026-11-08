import { describe, expect, it, vi } from 'vitest';
import { gatewayFor, type RankedRecommendation } from './client';
import type { SupabaseLike } from '@/services/supabaseClient';

type Rpc = SupabaseLike['rpc'];

function clientReturning(result: { data: unknown; error: { message: string } | null }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> | undefined }> = [];
  const rpc = vi.fn<Rpc>(async (fn, args) => {
    calls.push({ fn, args });
    return result;
  });
  return { client: { rpc } as unknown as Pick<SupabaseLike, 'rpc'>, calls };
}

describe('the intelligence gateway', () => {
  it('sends behaviour without a farmer id and with the session-derived cast', async () => {
    const { client, calls } = clientReturning({ data: 42, error: null });
    const gateway = gatewayFor(client);

    const accepted = await gateway.sendEvent({
      key: 'evt-1',
      type: 'product_view',
      at: 1_800_000_000_000,
      source: 'ui_interaction',
      subject: 'urea',
      cropCode: 'wheat',
      stage: 'flowering',
      context: { screen: 'shop', rank: 2 },
    });

    expect(accepted).toBe(true);
    expect(calls[0]?.fn).toBe('record_behaviour_event');
    expect(calls[0]?.args).toMatchObject({
      p_event_key: 'evt-1',
      p_signal_type: 'product_view',
      p_source: 'ui_interaction',
      p_subject: 'urea',
      p_crop_code: 'wheat',
      p_context: { screen: 'shop', rank: 2, stage: 'flowering' },
    });
    // The owner is never part of the payload: the server reads it from the JWT.
    expect(calls[0]?.args).not.toHaveProperty('p_farmer_id');
  });

  it('reports a refused write rather than assuming success', async () => {
    const { client } = clientReturning({ data: null, error: { message: 'insufficient_privilege' } });
    const gateway = gatewayFor(client);

    await expect(
      gateway.sendEvent({
        key: 'evt-2',
        type: 'search',
        at: 1_800_000_000_000,
        source: 'search',
        context: {},
      }),
    ).resolves.toBe(false);
  });

  it('sends feedback with its idempotency key and verdict', async () => {
    const { client, calls } = clientReturning({ data: 'fb-1', error: null });
    const gateway = gatewayFor(client);

    const accepted = await gateway.sendFeedback({
      key: 'fb-1',
      verdict: 'not_relevant',
      recommendationId: 'rec-1',
      insightRef: 'insight-1',
    });

    expect(accepted).toBe(true);
    expect(calls[0]?.fn).toBe('record_intelligence_feedback');
    expect(calls[0]?.args).toMatchObject({
      p_idempotency_key: 'fb-1',
      p_verdict: 'not_relevant',
      p_recommendation_id: 'rec-1',
    });
  });

  it('sends the validated crop context to preparation without a farmer id', async () => {
    const { client, calls } = clientReturning({ data: 2, error: null });
    const gateway = gatewayFor(client);

    await expect(
      gateway.prepareRecommendations([
        { crop_code: 'cotton', stage: 'fruiting', primary: true },
      ]),
    ).resolves.toBe(true);

    expect(calls[0]).toMatchObject({
      fn: 'prepare_my_recommendations',
      args: {
        p_crops: [{ crop_code: 'cotton', stage: 'fruiting', primary: true }],
      },
    });
    expect(calls[0]?.args).not.toHaveProperty('p_farmer_id');
  });

  it('maps a ranked row and drops a malformed one', async () => {
    const { client } = clientReturning({
      data: [
        {
          recommendation_id: 'rec-1',
          crop_id: 'crop-1',
          kind: 'pest',
          title: 'Scout for whitefly',
          body: 'Check the underside of leaves.',
          source: 'knowledge_base',
          confidence: 0.8,
          priority: 20,
          score: 0.74,
          components: { base_priority: 0.32, interest: 0.2 },
          valid_until: null,
        },
        { recommendation_id: 7, title: 'bad row' },
      ],
      error: null,
    });
    const gateway = gatewayFor(client);

    const rows: RankedRecommendation[] | null = await gateway.readRankedFeed(5);

    expect(rows).not.toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows?.[0]).toMatchObject({
      recommendationId: 'rec-1',
      kind: 'pest',
      score: 0.74,
      components: { interest: 0.2 },
    });
  });

  it('returns null context instead of throwing when the server refuses', async () => {
    const { client } = clientReturning({ data: null, error: { message: 'no rows' } });
    const gateway = gatewayFor(client);

    await expect(gateway.readContext()).resolves.toBeNull();
    await expect(gateway.readRankedFeed()).resolves.toBeNull();
    await expect(gateway.readInterestSettings()).resolves.toBeNull();
  });

  it('maps all interest rows and distinguishes failure from an empty list', async () => {
    const { client } = clientReturning({
      data: [
        {
          topic: 'topic:pest',
          crop_code: 'cotton',
          weight: 0.42,
          confidence: 0.6,
          source: 'explicit',
          pinned: true,
          updated_at: '2026-11-03T10:00:00.000Z',
        },
        { topic: 'broken' },
      ],
      error: null,
    });

    const rows = await gatewayFor(client).readInterestSettings();

    expect(rows).toHaveLength(1);
    expect(rows?.[0]).toMatchObject({
      topic: 'topic:pest',
      cropCode: 'cotton',
      pinned: true,
      source: 'explicit',
    });

    const empty = clientReturning({ data: [], error: null });
    await expect(gatewayFor(empty.client).readInterestSettings()).resolves.toEqual([]);
  });

  it('sends pin and dismissal without a farmer id', async () => {
    const { client, calls } = clientReturning({
      data: { topic: 'topic:pest', weight: 0.42, confidence: 0.6, source: 'behaviour', pinned: true },
      error: null,
    });
    const gateway = gatewayFor(client);

    const pinned = await gateway.setInterestPin('topic:pest', true);

    expect(pinned).toMatchObject({ topic: 'topic:pest', pinned: true });
    expect(calls[0]).toEqual({
      fn: 'set_farmer_interest_pin',
      args: { p_topic: 'topic:pest', p_pinned: true },
    });
    expect(calls[0]?.args).not.toHaveProperty('p_farmer_id');
  });

  it('never reports a dismissed interest when the server refuses', async () => {
    const refused = clientReturning({ data: null, error: { message: 'no_data_found' } });
    await expect(gatewayFor(refused.client).dismissInterest('topic:pest')).resolves.toBe(false);

    const accepted = clientReturning({ data: true, error: null });
    await expect(gatewayFor(accepted.client).dismissInterest('topic:pest')).resolves.toBe(true);
  });
});
