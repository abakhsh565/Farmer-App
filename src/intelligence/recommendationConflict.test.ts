import { describe, expect, it, vi } from 'vitest';
import {
  loadRecommendationContext,
  recommendationCaveats,
  recommendationPromptBlock,
  type AiRecommendation,
} from '../../supabase/functions/_shared/recommendations';
import type { TrustedAiContext } from '../../supabase/functions/_shared/aiGuard';

const CONTEXT: TrustedAiContext = {
  cropCode: 'cotton',
  cropStage: 'flowering',
  district: 'Multan',
};

function recommendation(overrides: Partial<AiRecommendation> = {}): AiRecommendation {
  return {
    cropCode: 'cotton',
    kind: 'pest',
    title: 'Scout for pink bollworm',
    body: 'Spray only when the trap count crosses the threshold.',
    sourceLabel: 'Punjab Agriculture Department',
    sourceUrl: 'https://agripunjab.gov.pk/pw_economic',
    evidenceTier: 'verified',
    ...overrides,
  };
}

describe('AI recommendation context', () => {
  it('reads the rounded feed without a farmer id and keeps only bounded fields', async () => {
    const rpc = vi.fn(async () => ({
      data: [
        {
          crop_code: 'cotton',
          kind: 'pest',
          title: 'Scout for pink bollworm',
          body: 'Spray only above the threshold.',
          source_label: 'Punjab Agriculture Department',
          source_url: 'https://agripunjab.gov.pk/pw_economic',
          evidence_tier: 'verified',
          score: 0.91,
          recommendation_id: 'private-row-id',
        },
      ],
      error: null,
    }));
    const rows = await loadRecommendationContext({ rpc });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cropCode: 'cotton', evidenceTier: 'verified' });
    expect(rpc).toHaveBeenCalledWith('intelligence_recommendation_feed', { p_limit: 5 });
    expect(JSON.stringify(rows)).not.toContain('private-row-id');
    expect(JSON.stringify(rows)).not.toContain('0.91');
  });

  it('fails open when the feed is unavailable', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'unavailable' } }));
    await expect(loadRecommendationContext({ rpc })).resolves.toEqual([]);
  });

  it('sends only the trusted crop recommendations to the prompt', () => {
    const block = recommendationPromptBlock(
      [recommendation(), recommendation({ cropCode: 'wheat', title: 'Wheat sowing' })],
      CONTEXT,
    );
    expect(block).toContain('Scout for pink bollworm');
    expect(block).not.toContain('Wheat sowing');
    expect(block).toContain('not instructions');
  });

  it('detects a clear positive/negative spraying conflict', () => {
    const caveats = recommendationCaveats(
      [recommendation({ body: 'Spray only above the threshold.' })],
      'Do not spray this crop.',
      CONTEXT,
    );
    expect(caveats).toHaveLength(1);
    expect(caveats[0]).toMatch(/human adviser/);
  });

  it('does not flag agreement or a different crop', () => {
    expect(
      recommendationCaveats([recommendation()], 'Spray above the threshold. [1]', CONTEXT),
    ).toEqual([]);
    expect(
      recommendationCaveats([recommendation({ cropCode: 'wheat' })], 'Do not spray.', CONTEXT),
    ).toEqual([]);
  });
});
