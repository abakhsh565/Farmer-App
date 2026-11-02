import { describe, expect, it } from 'vitest';
import {
  buildIntelCards,
  checkIntelRadius,
  DEFAULT_INTEL_RADIUS_M,
  INTEL_RADIUS_OPTIONS_M,
} from './feed';

const NOW = 1_700_000_000_000;

describe('intel feed (verified sources only)', () => {
  it('always carries the official advisory pointer, never a fabricated outbreak', () => {
    const cards = buildIntelCards({ cropNameKey: null, now: NOW });
    expect(cards.map((c) => c.id)).toEqual(['punjab-advisory']);
    const advisory = cards[0];
    expect(advisory?.id).toBe('punjab-advisory');
    expect(advisory?.evidence).toBe('official_advisory');
    expect(advisory?.sourceUrl).toContain('agripunjab.gov.pk');
  });

  it('adds the cotton vigilance card only for cotton growers', () => {
    expect(
      buildIntelCards({ cropNameKey: 'crop.cotton', now: NOW }).map((c) => c.id),
    ).toEqual(['punjab-advisory', 'cotton-bollworm-watch']);
    expect(buildIntelCards({ cropNameKey: 'crop.wheat', now: NOW })).toHaveLength(1);
  });

  it('is pure: same input, same cards, freshness pinned to now', () => {
    const a = buildIntelCards({ cropNameKey: 'crop.cotton', now: NOW });
    const b = buildIntelCards({ cropNameKey: 'crop.cotton', now: NOW });
    expect(a).toEqual(b);
    for (const card of a) expect(card.createdAt).toBe(NOW);
  });

  it('accepts the brief radii in metres and rejects the rest', () => {
    expect(INTEL_RADIUS_OPTIONS_M).toEqual([8_000, 10_000, 100_000, 500_000]);
    expect(() => checkIntelRadius(DEFAULT_INTEL_RADIUS_M)).not.toThrow();
    for (const bad of [0, -10, 500_001, Number.NaN]) {
      expect(() => checkIntelRadius(bad)).toThrow(RangeError);
    }
  });
});
