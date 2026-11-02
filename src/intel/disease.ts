/**
 * Is disease possible around this field, from the forecast for its area?
 *
 * WHAT THIS IS NOT
 *
 * It is not a diagnosis, and it is not a report of disease. Nothing here has been
 * seen in a field — it is what the weather over the next days does to the
 * *likelihood* of leaf disease, which is the question a farmer can act on by
 * walking the field. The card built on this says both things: the level, and the
 * numbers that produced it, so a farmer can disagree with the conclusion without
 * having to trust it.
 *
 * WHY RAIN AND TEMPERATURE
 *
 * Fungal leaf disease needs a wet leaf and a mild, warm canopy. Rain is the
 * honest proxy for the first — it is the one leaf-wetting signal a forecast
 * actually carries, and the app does not have leaf-wetness data — and the daily
 * maximum and minimum are the second. Both are measured, neither is invented.
 *
 * WHAT IS DELIBERATELY ABSENT
 *
 * A number attached to the level. There is no published threshold in this
 * repository's knowledge base that says "this much rain means rust", and a
 * percentage would be a precision nobody here can defend. So the levels are
 * words, the basis is shown, and no claim is made about which disease.
 */

import type { WeatherDay } from '@/services/types';

export type DiseasePressure = 'low' | 'watch' | 'favourable' | 'unknown';

export type DiseaseAssessment = {
  level: DiseasePressure;
  /** Days in the window, and how many of them carry rain. */
  days: number;
  rainDays: number;
  /** The temperature the window spans, when it was reported. */
  minC: number | null;
  maxC: number | null;
};

/** A day with this much rain is a wet-leaf day for this purpose. */
const RAIN_DAY_MM = 1;

/** Below this the canopy is too cold for leaf disease to build; above it, too hot. */
const TOO_COLD_MAX_C = 10;
const TOO_HOT_MIN_C = 35;

/** Rain from this many days of the week is enough for disease to get going. */
const FAVOURABLE_RAIN_DAYS = 3;

/**
 * Reads a forecast, or says it cannot.
 *
 * `unknown` is a first-class answer: a provider that returned nothing, or days
 * with no temperatures in them, is not the same as a dry week, and saying "low"
 * for it would be the app inventing calm weather out of a failed call.
 */
export function assessDiseasePressure(days: readonly WeatherDay[]): DiseaseAssessment {
  const usable = days.filter((day) => day.maxC !== null || day.minC !== null);
  if (usable.length === 0) {
    return { level: 'unknown', days: 0, rainDays: 0, minC: null, maxC: null };
  }

  const rainDays = usable.filter((day) => (day.precipMm ?? 0) >= RAIN_DAY_MM).length;

  const maxes = usable.map((day) => day.maxC).filter((value): value is number => value !== null);
  const mins = usable.map((day) => day.minC).filter((value): value is number => value !== null);
  const maxC = maxes.length > 0 ? Math.max(...maxes) : null;
  const minC = mins.length > 0 ? Math.min(...mins) : null;

  // A week that never gets warm, or never cools below a bake, does not carry leaf
  // disease however much it rains — so it is settled before the rain is counted.
  if (maxC !== null && maxC < TOO_COLD_MAX_C) {
    return { level: 'low', days: usable.length, rainDays, minC, maxC };
  }
  if (minC !== null && minC > TOO_HOT_MIN_C) {
    return { level: 'low', days: usable.length, rainDays, minC, maxC };
  }

  const level: DiseasePressure =
    rainDays >= FAVOURABLE_RAIN_DAYS ? 'favourable' : rainDays >= 1 ? 'watch' : 'low';

  return { level, days: usable.length, rainDays, minC, maxC };
}
