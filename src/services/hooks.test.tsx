import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useDealerSearch } from './hooks';
import { ServicesProvider, type Services } from './registry';
import type { DealerSummary, Sourced } from './types';

/**
 * The list on the Shop screen must never be an older answer under a newer label.
 *
 * On staging a radius change to 10 km rendered four shops 70–100 km away, because
 * the previous answer stayed on screen while the new request was in flight and the
 * heading already read the new radius. This locks the rule that an answer belongs
 * to the request that produced it.
 */
const shop = (id: string, distanceKm: number): DealerSummary => ({
  id,
  name: `Shop ${id}`,
  distanceKm,
  verifiedAt: null,
  openingHours: null,
  isAcceptingRequests: true,
  syncState: 'fresh',
  syncedAt: null,
  tags: [],
});

const sourced = (data: DealerSummary[]): Sourced<DealerSummary[]> => ({
  data,
  sourceLabel: 'test',
  observedAt: Date.now(),
  fetchedAt: Date.now(),
  freshness: 'fresh',
  status: 'live',
});

function setup(first: DealerSummary[], second: DealerSummary[]) {
  let releaseSecond: (() => void) | null = null;
  const search = vi
    .fn()
    .mockResolvedValueOnce(sourced(first))
    .mockImplementationOnce(
      () =>
        new Promise<Sourced<DealerSummary[]>>((resolve) => {
          releaseSecond = () => resolve(sourced(second));
        }),
    );

  const services = {
    dealer: { name: 'test', maxRadiusKm: 100, search },
  } as unknown as Services;

  const wrapper = ({ children }: { children: ReactNode }) => (
    <ServicesProvider services={services}>{children}</ServicesProvider>
  );

  const hook = renderHook(
    ({ radiusKm }: { radiusKm: number }) =>
      useDealerSearch({ radiusKm, origin: { lat: 31.5, lon: 74.3 } }),
    { wrapper, initialProps: { radiusKm: 100 } },
  );

  return { ...hook, search, release: () => releaseSecond?.() };
}

describe('useDealerSearch', () => {
  it('drops the old radius answer instead of showing it under the new radius', async () => {
    const near = shop('far', 70.2);
    const { result, rerender, release } = setup([near], []);

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.data).toEqual([near]);

    rerender({ radiusKm: 10 });

    /* The 100 km shops are not shown for the 10 km request. */
    expect(result.current.data).toEqual([]);
    expect(result.current.status).toBe('loading');

    release();
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.data).toEqual([]);
  });
});
