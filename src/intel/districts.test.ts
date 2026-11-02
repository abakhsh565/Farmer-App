import { describe, expect, it } from 'vitest';
import {
  DISTRICT_COVERAGE_M,
  PILOT_DISTRICTS,
  PILOT_DIVISION,
  districtByCode,
  districtName,
  nearestDistrict,
} from './districts';
import { distanceM } from './geo';

/**
 * The districts the pilot can name, and — more importantly — the point it refuses
 * to name one for.
 *
 * The refusal is the assertion that matters. A report from Gujranwala must not be
 * attributed to Layyah because Layyah happens to be the closest of six rows, and
 * the only way that stays true is if it is tested.
 */

describe('the pilot district list', () => {
  it('covers the six districts of the division with unique codes', () => {
    expect(PILOT_DISTRICTS).toHaveLength(6);
    const codes = PILOT_DISTRICTS.map((district) => district.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toEqual([
      'dera_ghazi_khan',
      'taunsa',
      'rajanpur',
      'layyah',
      'muzaffargarh',
      'kot_addu',
    ]);
    expect(PILOT_DIVISION).toBe('Dera Ghazi Khan');
  });

  it('keeps every headquarters inside Pakistan', () => {
    for (const district of PILOT_DISTRICTS) {
      expect(district.hqLat).toBeGreaterThan(23);
      expect(district.hqLat).toBeLessThan(38);
      expect(district.hqLon).toBeGreaterThan(60);
      expect(district.hqLon).toBeLessThan(78);
    }
  });

  it('carries a real Urdu name for each, not a transliteration of the code', () => {
    for (const district of PILOT_DISTRICTS) {
      expect(district.nameUr).not.toBe(district.nameEn);
      expect(district.nameUr).toMatch(/[\u0600-\u06FF]/);
      expect(district.nameEn).toMatch(/[A-Za-z]/);
    }
  });

  it('names the district in the script the reader is reading', () => {
    const layyah = districtByCode('layyah');
    expect(layyah).toBeDefined();
    expect(districtName(layyah!, 'ur')).toBe('لیہ');
    expect(districtName(layyah!, 'en')).toBe('Layyah');
    // The regional languages are RTL and fall through to the Urdu name, which is
    // still readable where the app is read.
    expect(districtName(layyah!, 'pa')).toBe('لیہ');
  });

  it('answers nothing for a code it does not carry', () => {
    expect(districtByCode('multan')).toBeUndefined();
    expect(districtByCode(null)).toBeUndefined();
  });
});

describe('attributing a point to a district', () => {
  it('picks the headquarters that is actually closest', () => {
    // Inside Layyah city: Layyah, not the division's own capital.
    const fromLayyah = nearestDistrict(30.9648, 70.9399);
    expect(fromLayyah?.district.code).toBe('layyah');
    expect(fromLayyah?.distanceM).toBe(0);

    // A village between Kot Addu and Muzaffargarh resolves to the nearer of the
    // two — asserted by comparing the two distances rather than by a hard number.
    const lat = 30.27;
    const lon = 71.08;
    const result = nearestDistrict(lat, lon);
    expect(result).not.toBeNull();
    const toKotAddu = distanceM(lat, lon, 30.4667, 70.9667);
    const toMuzaffargarh = distanceM(lat, lon, 30.0744, 71.1847);
    expect(result!.district.code).toBe(toKotAddu <= toMuzaffargarh ? 'kot_addu' : 'muzaffargarh');
  });

  it('claims no district outside the pilot division', () => {
    // Wazirabad, in Gujranwala division, 400+ km away.
    expect(nearestDistrict(32.443, 74.115)).toBeNull();
    // Karachi, further still.
    expect(nearestDistrict(24.86, 67.01)).toBeNull();
  });

  it('uses the coverage radius as the boundary, not as a suggestion', () => {
    // Just inside the limit, on a bearing from Layyah's headquarters.
    const kmPerLat = 110.574;
    const inside = nearestDistrict(30.9648 + (DISTRICT_COVERAGE_M - 5_000) / 1000 / kmPerLat, 70.9399);
    expect(inside?.district.code).toBe('layyah');

    const outside = nearestDistrict(30.9648 + (DISTRICT_COVERAGE_M + 5_000) / 1000 / kmPerLat, 70.9399);
    expect(outside).toBeNull();
  });

  it('refuses coordinates it cannot use rather than guessing', () => {
    expect(nearestDistrict(Number.NaN, 70.9)).toBeNull();
    expect(nearestDistrict(30.9, Number.POSITIVE_INFINITY)).toBeNull();
    expect(nearestDistrict(91, 70.9)).toBeNull();
    expect(nearestDistrict(30.9, 181)).toBeNull();
  });
});
