import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { parseRankedRecommendations } from './feed';
import { usePersonalizedFeed } from './usePersonalizedFeed';

const rows = parseRankedRecommendations([
  {
    recommendation_id: 'rec-1',
    kind: 'pest',
    title: 'Scout for whitefly',
    score: 0.74,
    components: { base_priority: 0.32, interest: 0.2 },
  },
  { recommendation_id: 'rec-2', kind: 'market', title: 'Hold the cotton', score: 0.5 },
]);

const setup = (overrides: Partial<Parameters<typeof usePersonalizedFeed>[0]> = {}) => {
  const load = vi.fn(async () => rows);
  const hook = renderHook(() =>
    usePersonalizedFeed({ accountId: 'account-a', enabled: true, online: true, load, ...overrides }),
  );
  return { ...hook, load };
};

describe('usePersonalizedFeed', () => {
  it('loads the ranked rows once and reports ready', async () => {
    const { result, load } = setup();

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.ranked.map((row) => row.recommendationId)).toEqual(['rec-1', 'rec-2']);
    expect(result.current.ranked[0]?.components).toEqual({ base_priority: 0.32, interest: 0.2 });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('treats an empty response as a fallback, not an empty feed', async () => {
    const load = vi.fn(async () => []);
    const { result } = renderHook(() =>
      usePersonalizedFeed({ accountId: 'account-a', enabled: true, online: true, load }),
    );

    await waitFor(() => expect(result.current.status).toBe('fallback'));
    expect(result.current.ranked).toEqual([]);
  });

  it('reports a failed load as an error, not as an empty feed', async () => {
    const load = vi.fn(async () => {
      throw new Error('network down');
    });
    const { result } = renderHook(() =>
      usePersonalizedFeed({ accountId: 'account-a', enabled: true, online: true, load }),
    );

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.ranked).toEqual([]);
  });

  it('does not call the RPC while offline and returns the fallback', async () => {
    const load = vi.fn(async () => rows);
    const { result } = renderHook(() =>
      usePersonalizedFeed({ accountId: 'account-a', enabled: true, online: false, load }),
    );

    expect(result.current.status).toBe('fallback');
    expect(load).not.toHaveBeenCalled();
  });

  it('does not refetch on re-render', async () => {
    const { result, rerender, load } = setup();
    await waitFor(() => expect(result.current.status).toBe('ready'));

    rerender();
    rerender();

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('refetches only when refresh is requested', async () => {
    const { result, load } = setup();
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => result.current.refresh());

    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });

  it('reloads for a different account', async () => {
    const load = vi.fn(async () => rows);
    const { result, rerender } = renderHook(
      ({ accountId }: { accountId: string }) =>
        usePersonalizedFeed({ accountId, enabled: true, online: true, load }),
      { initialProps: { accountId: 'account-a' } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    rerender({ accountId: 'account-b' });

    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it('stays idle without an account', async () => {
    const load = vi.fn(async () => rows);
    const { result } = renderHook(() =>
      usePersonalizedFeed({ accountId: null, enabled: false, online: true, load }),
    );

    expect(result.current.status).toBe('idle');
    expect(load).not.toHaveBeenCalled();
  });
});
