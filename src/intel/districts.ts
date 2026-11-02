/**
 * The pilot division's districts, as the client knows them.
 *
 * This mirrors the seed in
 * `supabase/migrations/20261015000000_dgkhan_intake.sql` exactly — the same six
 * codes, the same headquarters coordinates — on purpose. On a configured backend
 * the rows live in `public.districts`; this copy exists so the report composer can
 * label a district, and so the app can say honestly that a point is *outside* the
 * pilot area, without a round trip.
 *
 * Why the names are not in the message catalog, when every other visible string
 * is: district names are database reference data, not interface copy. Putting
 * them in the catalog would create a second source of truth for rows the
 * migration already carries in both languages, and the two would drift. The
 * catalog holds wording; this holds reference data.
 *
 * Coordinates are the *headquarters city*, used as a fetch and attribution point.
 * They are never a farm location, and `nearestDistrict` exists only to name a
 * district — never to calculate a distance the app then presents as field-level
 * precision.
 */

import type { Locale } from '@/i18n/locales';
import { LOCALE_REGISTRY } from '@/i18n/locales';
import { distanceM } from './geo';

export type District = {
  /** Matches `districts.code`, which is what a report stores. */
  code: string;
  nameEn: string;
  nameUr: string;
  hqLat: number;
  hqLon: number;
};

/** The division this pilot covers. A point outside it gets no district claimed. */
export const PILOT_DIVISION = 'Dera Ghazi Khan';

export const PILOT_DISTRICTS: readonly District[] = [
  { code: 'dera_ghazi_khan', nameEn: 'Dera Ghazi Khan', nameUr: 'ڈیرہ غازی خان', hqLat: 30.0325, hqLon: 70.6402 },
  { code: 'taunsa', nameEn: 'Taunsa', nameUr: 'تونسہ', hqLat: 30.7056, hqLon: 70.6578 },
  { code: 'rajanpur', nameEn: 'Rajanpur', nameUr: 'راجن پور', hqLat: 29.1038, hqLon: 70.3202 },
  { code: 'layyah', nameEn: 'Layyah', nameUr: 'لیہ', hqLat: 30.9648, hqLon: 70.9399 },
  { code: 'muzaffargarh', nameEn: 'Muzaffargarh', nameUr: 'مظفر گڑھ', hqLat: 30.0744, hqLon: 71.1847 },
  { code: 'kot_addu', nameEn: 'Kot Addu', nameUr: 'کوٹ ادو', hqLat: 30.4667, hqLon: 70.9667 },
];

/**
 * How far a point may sit from a district headquarters and still be attributed to
 * it: 120 km, a little over the widest span between neighbouring headquarters in
 * this division. Beyond it the honest answer is that the app does not know which
 * district the reporter is in, and it says so rather than naming the closest one
 * — naming a district 300 km away would be a made-up attribution.
 */
export const DISTRICT_COVERAGE_M = 120_000;

export function districtByCode(code: string | null | undefined): District | undefined {
  if (!code) return undefined;
  return PILOT_DISTRICTS.find((district) => district.code === code);
}

/** The district's name in the language being read, falling back to English. */
export function districtName(district: District, locale: Locale): string {
  return LOCALE_REGISTRY[locale].dir === 'rtl' ? district.nameUr : district.nameEn;
}

/**
 * The nearest pilot district to a point, or null when the point is outside the
 * pilot's coverage (or the coordinates are not usable).
 *
 * Null is a first-class answer here: a report from outside the division is stored
 * with its own area label and no district, which is different from — and better
 * than — a wrong district.
 */
export function nearestDistrict(
  lat: number,
  lon: number,
  coverageM: number = DISTRICT_COVERAGE_M,
): { district: District; distanceM: number } | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  let best: { district: District; distanceM: number } | null = null;
  for (const district of PILOT_DISTRICTS) {
    const metres = distanceM(lat, lon, district.hqLat, district.hqLon);
    if (best === null || metres < best.distanceM) best = { district, distanceM: metres };
  }

  if (best === null || best.distanceM > coverageM) return null;
  return best;
}
