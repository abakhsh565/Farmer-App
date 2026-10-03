import type { MessageKey } from '@/i18n/catalog';
import type { GeoPoint } from '@/services/types';

/**
 * Dealer discovery: where the farmer is, where the searches may look, and what
 * each dealer's row is called.
 *
 * What is *not* here any more is the dealer list itself. It used to be: five
 * shops with a distance per search area, written down by hand. Those numbers were
 * plausible and unfalsifiable — "1.8 km" was a claim nothing could check, and the
 * temporary-search-area rule could only be tested by trusting the table. The list,
 * the distances, the opening state, the stock and the sync freshness now come from
 * the dealer service, which computes distance from coordinates, and this module
 * holds only the two things a screen legitimately owns: where the areas are, and
 * what to call a dealer in the farmer's language.
 */

export type AreaId = 'wazirabad' | 'kotLadha' | 'gujranwala' | 'hafizabad';

export type Area = {
  id: AreaId;
  nameKey: MessageKey;
  /** Real coordinates, so a search from here produces real distances. */
  point: GeoPoint;
};

export const AREAS: ReadonlyArray<Area> = [
  { id: 'wazirabad', nameKey: 'area.wazirabad', point: { lat: 32.443, lon: 74.115 } },
  { id: 'kotLadha', nameKey: 'area.kotLadha', point: { lat: 32.55, lon: 74.05 } },
  { id: 'gujranwala', nameKey: 'area.gujranwala', point: { lat: 32.1877, lon: 74.1945 } },
  { id: 'hafizabad', nameKey: 'area.hafizabad', point: { lat: 32.0702, lon: 73.688 } },
];

/** The farmer's profile location — the default the temporary area never replaces. */
export const PROFILE_AREA: AreaId = 'wazirabad';

export const PROFILE_POINT: GeoPoint = AREAS.find((area) => area.id === PROFILE_AREA)
  ?.point ?? { lat: 32.443, lon: 74.115 };

export function areaPoint(areaId: AreaId): GeoPoint {
  return AREAS.find((area) => area.id === areaId)?.point ?? PROFILE_POINT;
}

export function areaNameKey(areaId: AreaId): MessageKey {
  return AREAS.find((area) => area.id === areaId)?.nameKey ?? 'farmer.village';
}

/** The largest radius the product allows; the choice inside it is the farmer's. */
export const MAX_RADIUS_KM = 100;

export const RADIUS_OPTIONS: readonly number[] = [5, 10, 25, 100];

/**
 * How a dealer's row is labelled.
 *
 * Keyed by the dealer service's id so that the same shop keeps the same name in
 * every language. A dealer the table does not know — a real one from the shop-side
 * system, added after this build — falls back to the name the service reports,
 * which is the same rule the market feed uses for a commodity the catalogue has no
 * key for. Showing an English name is a smaller failure than showing a raw key.
 */
export const DEALER_DISPLAY: Readonly<
  Record<string, { nameKey: MessageKey; hour: number; yours?: boolean }>
> = {
  'dealer.aliTraders': { nameKey: 'dealer.aliTraders', hour: 20, yours: true },
  'dealer.greenAgro': { nameKey: 'dealer.greenAgro', hour: 19 },
  'dealer.wazirabadAgri': { nameKey: 'dealer.wazirabadAgri', hour: 21 },
  'dealer.malikFertilizers': { nameKey: 'dealer.malikFertilizers', hour: 18 },
  'dealer.punjabSeed': { nameKey: 'dealer.punjabSeed', hour: 18 },
};

/** The tags a dealer row can be filtered by, and the words for them. */
export type DealerTag = 'cotton' | 'fertilizer' | 'pesticide' | 'seed';

export const TAG_LABEL: Readonly<Record<string, MessageKey>> = {
  cotton: 'crop.cotton',
  fertilizer: 'dealers.filter.fertilizer',
  pesticide: 'dealers.filter.pesticide',
  seed: 'dealers.filter.seed',
};

export function tagLabel(tag: string): MessageKey | null {
  return TAG_LABEL[tag] ?? null;
}

export function dealerNameKey(id: string): MessageKey | null {
  return DEALER_DISPLAY[id]?.nameKey ?? null;
}

/** The closing hour the row shows, when the dealer table knows the shop. */
export function closingHour(id: string): number | null {
  return DEALER_DISPLAY[id]?.hour ?? null;
}
