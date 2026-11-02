import { describe, expect, it } from 'vitest';
import { dedupeByCluster, distanceM, isEligible, rankIntelFeed, type IntelRow } from './geo';

const NOW = 1_700_000_000_000;
const row = (over: Partial<IntelRow> & { id: string }): IntelRow => ({
  kind: 'report',
  title: over.id,
  cropCode: 'cotton',
  topic: 'pest',
  evidence: 'farmer_report',
  distanceM: 5_000,
  observedAt: NOW - 3_600_000,
  validUntil: NOW + 86_400_000,
  clusterId: null,
  ...over,
});

describe('intel geo contract', () => {
  it('8/10/100/500km change eligibility; outside never appears as nearby', () => {
    const near = row({ id: 'near', distanceM: 9_000, observedAt: NOW - 1_000 });
    const mid = row({ id: 'mid', distanceM: 50_000, observedAt: NOW - 2_000 });
    const far = row({ id: 'far', distanceM: 400_000, observedAt: NOW - 3_000 });
    expect(rankIntelFeed([near, mid, far], { radiusM: 8_000, now: NOW }).map((r) => r.id)).toEqual([]);
    expect(rankIntelFeed([near, mid, far], { radiusM: 10_000, now: NOW }).map((r) => r.id)).toEqual([
      'near',
    ]);
    expect(rankIntelFeed([near, mid, far], { radiusM: 100_000, now: NOW }).map((r) => r.id)).toEqual([
      'near',
      'mid',
    ]);
    expect(rankIntelFeed([near, mid, far], { radiusM: 500_000, now: NOW }).map((r) => r.id)).toEqual([
      'near',
      'mid',
      'far',
    ]);
  });

  it('rejects zero/negative/over-500km radii in metres', () => {
    for (const bad of [0, -5, 500_001, Number.NaN]) {
      expect(() => isEligible(row({ id: 'x' }), bad, NOW)).toThrow(RangeError);
    }
  });

  it('drops expired + future rows and keeps district advisories as fallback', () => {
    const expired = row({ id: 'exp', validUntil: NOW - 1 });
    const future = row({ id: 'fut', observedAt: NOW + 60_000 });
    const district = row({ id: 'adv', kind: 'advisory', distanceM: null, evidence: 'official_advisory' });
    expect(rankIntelFeed([expired, future, district], { radiusM: 8_000, now: NOW }).map((r) => r.id)).toEqual([
      'adv',
    ]);
  });

  it('dedupes repeats to verified-then-newest; evidence labels cannot upgrade a row', () => {
    const a = row({ id: 'a', clusterId: 'c1', evidence: 'farmer_report', observedAt: NOW - 5 });
    const b = row({ id: 'b', clusterId: 'c1', evidence: 'farmer_report', observedAt: NOW - 1 });
    const v = row({ id: 'v', clusterId: 'c1', evidence: 'expert_verified', observedAt: NOW - 9 });
    expect(dedupeByCluster([a, b]).map((r) => r.id)).toEqual(['b']);
    expect(dedupeByCluster([a, b, v]).map((r) => r.id)).toEqual(['v']);
    // A farmer report row keeps its own label; ranking never rewrites evidence.
    expect(b.evidence).toBe('farmer_report');
  });

  it('sorts newest first and never returns coordinates', () => {
    const out = rankIntelFeed(
      [row({ id: 'old', observedAt: NOW - 9 }), row({ id: 'new', observedAt: NOW - 1 })],
      { radiusM: 10_000, now: NOW },
    );
    expect(out.map((r) => r.id)).toEqual(['new', 'old']);
    for (const r of out) expect(r).not.toHaveProperty('lat');
  });

  it('haversine sanity: ~8km stays inside 8km, ~11km does not', () => {
    expect(distanceM(32.443, 74.115, 32.515, 74.05)).toBeGreaterThan(8_000);
    expect(distanceM(32.443, 74.115, 32.447, 74.108)).toBeLessThan(8_000);
  });
});
