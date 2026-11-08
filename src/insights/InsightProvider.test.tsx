import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RankedRecommendation } from '@/intelligence/feed';

/**
 * The provider is the seam between the server's ranking and Home's existing
 * local insights. These tests pin exactly that seam: the hook receives the
 * farmer's identity and connectivity, and the *same* local objects come back in
 * the server's order — with the local order untouched whenever ranking is
 * unavailable.
 */

const state = vi.hoisted(() => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const crop = {
    id: 'crop-1',
    nameKey: 'crop.cotton',
    stageKey: 'crop.stage.bollFormation',
    stageConfirmed: true,
    plantedAt: now - 30 * DAY,
    primary: true,
  };
  const insight = (id: string, kind: string, priority: string, createdAt: number) => ({
    id,
    cropId: 'crop-1',
    kind,
    priority,
    titleKey: 'insight.pest.title',
    bodyKey: 'insight.pest.body',
    actionKey: 'insight.pest.action',
    sourceKey: 'insight.source.knowledge',
    knowledgeVersion: 'v1',
    confidence: 0.8,
    createdAt,
    validUntil: now + 7 * DAY,
    status: 'active',
  });
  return {
    now,
    // Deliberately local order is pest (high) before market (normal), while the
    // server prefers market. A pass cannot happen by accident.
    data: {
      crops: [crop],
      insights: [
        insight('local-market', 'market', 'normal', now - 1_000),
        insight('local-pest', 'pest', 'high', now - 2_000),
      ],
      notifications: [],
    },
    account: { id: 'account-1' } as { id: string } | null,
    online: true,
    ranked: [] as RankedRecommendation[],
    status: 'fallback' as 'idle' | 'loading' | 'ready' | 'fallback',
    calls: [] as Array<{ accountId: string | null; enabled: boolean; online: boolean }>,
    refresh: vi.fn(),
    setData: vi.fn(),
  };
});

vi.mock('@/session/SessionProvider', () => ({
  useSession: () => ({ account: state.account }),
}));

vi.mock('@/services/persistence', () => ({
  ownerFor: () => 'owner-1',
  useOnline: () => state.online,
  usePersistentDocument: () => ({ data: state.data, setData: state.setData }),
}));

vi.mock('@/i18n/LocaleProvider', () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/insights/Insights', () => ({
  InsightSheets: () => null,
}));

vi.mock('@/intelligence/usePersonalizedFeed', () => ({
  usePersonalizedFeed: (params: { accountId: string | null; enabled: boolean; online: boolean }) => {
    state.calls.push(params);
    return { ranked: state.ranked, status: state.status, refresh: state.refresh };
  },
}));

import { InsightProvider, useInsights } from './InsightProvider';

const wrapper = ({ children }: { children: ReactNode }) => (
  <InsightProvider>{children}</InsightProvider>
);

const serverRow = (overrides: Partial<RankedRecommendation> = {}): RankedRecommendation => ({
  recommendationId: 'server-1',
  cropId: null,
  cropCode: null,
  kind: 'market',
  title: 'Hold the cotton',
  titleUr: null,
  body: '',
  bodyUr: null,
  source: 'market',
  sourceLabel: null,
  sourceUrl: null,
  evidenceTier: null,
  confidence: null,
  priority: 100,
  score: 0.5,
  components: {},
  reasonCode: null,
  reasonContext: {},
  ruleVersion: null,
  actionKind: null,
  actionLabel: null,
  actionLabelUr: null,
  validUntil: null,
  createdAt: null,
  ...overrides,
});

describe('InsightProvider personalization seam', () => {
  beforeEach(() => {
    state.account = { id: 'account-1' };
    state.online = true;
    state.ranked = [];
    state.status = 'fallback';
    state.calls = [];
    state.refresh = vi.fn();
  });

  it('orders the existing local insights by the server ranking', () => {
    state.ranked = [serverRow()];
    state.status = 'ready';
    const { result } = renderHook(() => useInsights(), { wrapper });

    const feed = result.current.forCrop('crop-1');

    expect(feed.map((insight) => insight.id)).toEqual(['local-market', 'local-pest']);
    // The cards are the farmer's own objects, not server copies.
    expect(feed[0]).toBe(state.data.insights[0]);
    expect(feed[0]?.titleKey).toBe('insight.pest.title');
    expect(result.current.recommendationFor('local-market')).toMatchObject({
      recommendationId: 'server-1',
    });
    expect(result.current.recommendationFor('local-pest')).toBeNull();
    expect(state.calls[0]).toEqual({
      accountId: 'account-1',
      enabled: true,
      online: true,
      crops: state.data.crops,
    });
  });

  it('leaves the local order untouched on fallback', () => {
    state.ranked = [];
    state.status = 'fallback';
    const { result } = renderHook(() => useInsights(), { wrapper });

    expect(result.current.forCrop('crop-1').map((insight) => insight.id)).toEqual([
      'local-pest',
      'local-market',
    ]);
    expect(result.current.personalizationStatus).toBe('fallback');
  });

  it('forwards account switches and connectivity without fetching anything itself', () => {
    const { rerender } = renderHook(() => useInsights(), { wrapper });

    state.account = { id: 'account-2' };
    state.online = false;
    rerender();

    expect(state.calls.at(-1)).toEqual({
      accountId: 'account-2',
      enabled: true,
      online: false,
      crops: state.data.crops,
    });

    state.account = null;
    rerender();

    expect(state.calls.at(-1)).toEqual({
      accountId: null,
      enabled: false,
      online: false,
      crops: state.data.crops,
    });
  });
});
