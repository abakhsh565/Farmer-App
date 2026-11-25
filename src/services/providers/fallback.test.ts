import { describe, expect, it } from 'vitest';
import { ChainedDealerProvider } from './fallback';
import type { DealerProvider, DealerSummary, Sourced } from '../types';

/**
 * The chain's rule, stated as tests: rows win, empty does not stop the question,
 * and a failure never hides a shop the next source actually has.
 */

const shop = (id: string, name: string, distanceKm: number): DealerSummary => ({
  id,
  name,
  distanceKm,
  verifiedAt: null,
  openingHours: null,
  openNow: true,
  isAcceptingRequests: true,
  syncState: 'fresh',
  syncedAt: null,
  tags: [],
});

function answer(
  label: string,
  rows: DealerSummary[],
  status: Sourced<DealerSummary[]>['status'] = 'live',
): Sourced<DealerSummary[]> {
  return {
    data: rows,
    sourceLabel: label,
    observedAt: 1_700_000_000_000,
    fetchedAt: 1_700_000_000_000,
    freshness: status === 'live' ? 'fresh' : 'unavailable',
    status,
    ...(status === 'failing' ? { error: `${label} is down.` } : {}),
  };
}

/** A dealer source that answers the same way to everything, for one assertion. */
function source(result: Sourced<DealerSummary[]> | Error): DealerProvider {
  const read = async () => {
    if (result instanceof Error) throw result;
    return result;
  };

  return {
    name: result instanceof Error ? 'Throwing source' : result.sourceLabel,
    maxRadiusKm: 100,
    search: read,
    products: async () => answer(result instanceof Error ? 'x' : result.sourceLabel, []),
    stockists: async () => answer(result instanceof Error ? 'x' : result.sourceLabel, []),
    searchProducts: async () => answer(result instanceof Error ? 'x' : result.sourceLabel, []),
  } as unknown as DealerProvider;
}

const query = { radiusKm: 10, origin: { lat: 32.443, lon: 74.115 } };

describe('a dealer chain', () => {
  it('takes the first source that has shops, and keeps its own label', async () => {
    const chain = new ChainedDealerProvider([
      source(answer('Farmer API', [shop('a', 'Al-Madina', 0.5)])),
      source(answer('Marketplace', [shop('b', 'Other shop', 2)])),
    ]);

    const result = await chain.search(query);

    expect(result.data.map((entry) => entry.name)).toEqual(['Al-Madina']);
    expect(result.sourceLabel).toBe('Farmer API');
  });

  it('falls through when the first source answers with nothing near the farmer', async () => {
    const chain = new ChainedDealerProvider([
      source(answer('Farmer API', [])),
      source(answer('Marketplace', [shop('b', 'Other shop', 2)])),
    ]);

    const result = await chain.search(query);

    expect(result.data.map((entry) => entry.id)).toEqual(['b']);
    expect(result.sourceLabel).toBe('Marketplace');
  });

  it('prefers a shop over an earlier failure', async () => {
    const chain = new ChainedDealerProvider([
      source(answer('Farmer API', [], 'failing')),
      source(answer('Marketplace', [shop('b', 'Other shop', 2)])),
    ]);

    expect((await chain.search(query)).sourceLabel).toBe('Marketplace');
  });

  it('still reports an empty area when every source is empty', async () => {
    const chain = new ChainedDealerProvider([
      source(answer('Farmer API', [])),
      source(answer('Marketplace', [])),
    ]);

    const result = await chain.search(query);

    expect(result.data).toEqual([]);
    expect(result.status).toBe('live');
  });

  it('reports the first failure when no source answered at all', async () => {
    const chain = new ChainedDealerProvider([
      source(answer('Farmer API', [], 'failing')),
      source(answer('Marketplace', [], 'failing')),
    ]);

    const result = await chain.search(query);

    expect(result.status).toBe('failing');
    expect(result.error).toBe('Farmer API is down.');
  });

  it('treats a throwing source as a source that did not answer', async () => {
    const chain = new ChainedDealerProvider([
      source(new Error('boom')),
      source(answer('Marketplace', [shop('b', 'Other shop', 2)])),
    ]);

    expect((await chain.search(query)).sourceLabel).toBe('Marketplace');
  });
});
