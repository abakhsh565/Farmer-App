import type { MessageKey } from '@/i18n/catalog';

/**
 * Weather, shaped like an adapter response rather than a screen.
 *
 * The rule the PRD locks is narrow and easy to break: a number is only shown with
 * the provider it came from and how old it is, and advice that depends on the
 * weather is paused when the reading is not good enough to act on. That is what
 * `freshnessOf` is for, and why the reading — not the screen — carries the
 * provider and the observation time.
 *
 * The provider is WeatherAPI.com because the accepted baseline names it as the
 * initial commercial candidate; swapping providers means changing this file's
 * keys, not the screens. When the real backend lands, the reading arrives from an
 * Edge Function and this module becomes its client-side shape.
 */

export type WeatherReading = {
  sourceKey: MessageKey;
  observedAt: number;
  conditionKey: MessageKey;
  tempC: number;
  humidity: number;
  windKey: MessageKey;
  /* The interpretation layer: provider facts above, farming advice down here. */
  sprayKey: MessageKey;
  sprayOtherKey: MessageKey;
  rainKey: MessageKey;
};

export type Freshness = 'fresh' | 'stale' | 'expired';

/** Under 90 minutes is fresh; past six hours it is not actionable at all. */
export const FRESH_MS = 90 * 60 * 1000;
export const EXPIRED_MS = 6 * 60 * 60 * 1000;

export function freshnessOf(observedAt: number, now: number): Freshness {
  const age = now - observedAt;
  if (age <= FRESH_MS) return 'fresh';
  if (age <= EXPIRED_MS) return 'stale';
  return 'expired';
}

export function createReading(now: number): WeatherReading {
  return {
    sourceKey: 'source.weather',
    observedAt: now - 25 * 60 * 1000,
    conditionKey: 'weather.condition',
    tempC: 34,
    humidity: 58,
    windKey: 'weather.wind',
    sprayKey: 'weather.spray',
    sprayOtherKey: 'weather.sprayOther',
    rainKey: 'weather.rain',
  };
}
