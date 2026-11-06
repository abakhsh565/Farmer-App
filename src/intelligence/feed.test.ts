import { describe, expect, it } from 'vitest';
import {
  orderByServerRanking,
  parseRankedRecommendations,
  recommendationForInsight,
} from './feed';

const row = (overrides: Record<string, unknown> = {}) => ({
  recommendation_id: 'rec-1',
  crop_id: 'crop-a',
  kind: 'pest',
  title: 'Scout for whitefly',
  body: 'Check the underside of the leaves.',
  source: 'knowledge_base',
  confidence: 0.8,
  priority: 20,
  score: 0.74,
  components: { base_priority: 0.32, interest: 0.2 },
  valid_until: null,
  ...overrides,
});

describe('the recommendation adapter', () => {
  it('keeps the RPC order, score and components', () => {
    const parsed = parseRankedRecommendations([row(), row({ recommendation_id: 'rec-2', score: 0.5 })]);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      recommendationId: 'rec-1',
      score: 0.74,
      components: { base_priority: 0.32, interest: 0.2 },
    });
    expect(parsed[1]?.recommendationId).toBe('rec-2');
  });

  it('drops duplicates rather than showing the same advice twice', () => {
    const parsed = parseRankedRecommendations([row(), row({ score: 0.9 })]);
    expect(parsed).toHaveLength(1);
  });

  it('drops malformed rows and survives a non-array payload', () => {
    const parsed = parseRankedRecommendations([
      row(),
      { recommendation_id: 'missing-title' },
      { title: 'missing id' },
      'not a row',
      null,
    ]);

    expect(parsed.map((entry) => entry.recommendationId)).toEqual(['rec-1']);
    expect(parseRankedRecommendations(null)).toEqual([]);
    expect(parseRankedRecommendations({ rows: [row()] })).toEqual([]);
  });

  it('carries localized copy, reason, trust and action metadata through', () => {
    const parsed = parseRankedRecommendations([
      row({
        title_ur: 'گلابی سنڈی کی جانچ',
        body_ur: 'پانچ پودے دیکھیں۔',
        source_label: 'Punjab Agriculture Department',
        source_url: 'https://agripunjab.gov.pk/pw_economic',
        evidence_tier: 'verified',
        reason_code: 'crop_stage',
        reason_context: { crop_code: 'cotton', stage: 'fruiting' },
        rule_version: 2,
        action_kind: 'open_scan',
        action_label_ur: 'فصل اسکین کریں',
      }),
    ]);

    expect(parsed[0]).toMatchObject({
      titleUr: 'گلابی سنڈی کی جانچ',
      bodyUr: 'پانچ پودے دیکھیں۔',
      sourceLabel: 'Punjab Agriculture Department',
      sourceUrl: 'https://agripunjab.gov.pk/pw_economic',
      evidenceTier: 'verified',
      reasonCode: 'crop_stage',
      reasonContext: { crop_code: 'cotton', stage: 'fruiting' },
      ruleVersion: 2,
      actionKind: 'open_scan',
      actionLabelUr: 'فصل اسکین کریں',
    });
  });

  it('drops an unsafe source URL instead of rendering it', () => {
    const parsed = parseRankedRecommendations([row({ source_url: 'http://example.test' })]);
    expect(parsed[0]?.sourceUrl).toBeNull();
  });

  it('fills safe defaults for optional fields without inventing content', () => {
    const parsed = parseRankedRecommendations([
      { recommendation_id: 'rec-3', title: '  Water after the rain  ' },
    ]);

    expect(parsed[0]).toMatchObject({
      recommendationId: 'rec-3',
      title: 'Water after the rain',
      kind: 'general',
      body: '',
      score: 0,
      components: {},
    });
  });
});

describe('applying the server ranking', () => {
  const local = [
    { id: 'local-weather', kind: 'weather', cropId: 'crop-1' },
    { id: 'local-pest', kind: 'pest', cropId: 'crop-1' },
    { id: 'local-market', kind: 'market', cropId: 'crop-2' },
  ];

  it('moves matched insights into the order the server returned', () => {
    const ranked = parseRankedRecommendations([
      row({ recommendation_id: 'r1', kind: 'market', crop_id: 'server-crop' }),
      row({ recommendation_id: 'r2', kind: 'pest', crop_id: 'server-crop' }),
    ]);

    expect(orderByServerRanking(local, ranked).map((entry) => entry.id)).toEqual([
      'local-market',
      'local-pest',
      'local-weather',
    ]);
  });

  it('leaves unmatched insights after the ranked ones in their original order', () => {
    const ranked = parseRankedRecommendations([row({ kind: 'market' })]);
    expect(orderByServerRanking(local, ranked).map((entry) => entry.id)).toEqual([
      'local-market',
      'local-weather',
      'local-pest',
    ]);
  });

  it('does not re-sort by score — that would duplicate the server formula', () => {
    const ranked = parseRankedRecommendations([
      row({ recommendation_id: 'r1', kind: 'pest', score: 0.1 }),
      row({ recommendation_id: 'r2', kind: 'market', score: 0.99 }),
    ]);

    // The RPC's order wins even though the second row has the higher score.
    expect(orderByServerRanking(local, ranked).slice(0, 2).map((entry) => entry.id)).toEqual([
      'local-pest',
      'local-market',
    ]);
  });

  it('returns the local order unchanged when there is no ranking', () => {
    expect(orderByServerRanking(local, []).map((entry) => entry.id)).toEqual(
      local.map((entry) => entry.id),
    );
  });
});

describe('the feedback target matcher', () => {
  const localInsights = [
    { id: 'local-pest', kind: 'pest', cropId: 'crop-1' },
    { id: 'local-market', kind: 'market', cropId: 'crop-1' },
  ];

  it('returns the single same-kind row when both sides are unambiguous', () => {
    const ranked = parseRankedRecommendations([row({ kind: 'pest' })]);
    expect(recommendationForInsight(localInsights[0]!, localInsights, ranked)).toMatchObject({
      recommendationId: 'rec-1',
      kind: 'pest',
    });
  });

  it('refuses a multi-row kind instead of guessing', () => {
    const ranked = parseRankedRecommendations([
      row({ recommendation_id: 'rec-1', kind: 'pest' }),
      row({ recommendation_id: 'rec-2', kind: 'pest' }),
    ]);
    expect(recommendationForInsight(localInsights[0]!, localInsights, ranked)).toBeNull();
  });

  it('refuses when two local insights share the kind', () => {
    const ranked = parseRankedRecommendations([row({ kind: 'pest' })]);
    const twoLocal = [...localInsights, { id: 'local-pest-2', kind: 'pest', cropId: 'crop-2' }];
    expect(recommendationForInsight(twoLocal[0]!, twoLocal, ranked)).toBeNull();
  });

  it('uses an exact crop match when one actually exists', () => {
    const ranked = parseRankedRecommendations([
      row({ recommendation_id: 'rec-1', kind: 'pest', crop_id: 'crop-1' }),
      row({ recommendation_id: 'rec-2', kind: 'pest', crop_id: 'other-crop' }),
    ]);
    expect(recommendationForInsight(localInsights[0]!, localInsights, ranked)?.recommendationId).toBe(
      'rec-1',
    );
  });

  it('returns null when no ranked row matches', () => {
    const ranked = parseRankedRecommendations([row({ kind: 'weather' })]);
    expect(recommendationForInsight(localInsights[0]!, localInsights, ranked)).toBeNull();
  });
});
