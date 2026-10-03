/**
 * Screen-facing reads of the service layer.
 *
 * The PRD's rule is that nothing may be hard-wired to a provider, and that the
 * UI and the assistant must read the *same* normalised service so they can never
 * disagree about the number in front of the farmer. Screens therefore do not
 * touch a provider directly and do not import a fixture: they ask these hooks,
 * which ask the configured provider.
 *
 * Three behaviours here are the point of the file rather than plumbing:
 *
 * · A refresh never blanks the screen. When the radius changes or a retry is
 *   pressed, the previous answer stays visible and `refreshing` goes true, because
 *   a dealer list that disappears and reappears is worse than one that is a second
 *   out of date. `status` is therefore about whether there is anything to show,
 *   not about whether a request is in flight.
 *
 * · The provider's own report travels with the data. `sourced` carries the source
 *   label, the observation time, the freshness and the provider's health, so a
 *   screen cannot render a figure without also being able to say where it came
 *   from and how old it is — which is the rule, enforced by the shape.
 *
 * · A failing provider is not a failed screen. A weather service that cannot be
 *   reached yields `status: 'ready'` with `sourced.status === 'failing'`, and the
 *   screen shows the "advice is paused" state from the *data*. Only a broken
 *   promise — a bug or a transport error — produces `status: 'error'`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { PROFILE_POINT } from '@/data/dealers';
import { useServices, type Services } from './registry';
import type {
  DealerProduct,
  DealerSearchQuery,
  DealerStockist,
  DealerSummary,
  GeoPoint,
  MarketRate,
  Sourced,
  WeatherDay,
  WeatherNow,
} from './types';

export type Resource<T> = {
  /** 'loading' only while there is nothing to show yet. */
  status: 'loading' | 'ready' | 'error';
  /** True while a request is in flight over content that is already on screen. */
  refreshing: boolean;
  data: T;
  /** The provider's report: source, observation time, freshness and health. */
  sourced: Sourced<T> | null;
  /** Set only when the call itself failed — a bug or a transport error. */
  error: string | null;
  loadedAt: number | null;
  retry: () => void;
};

const EMPTY: readonly never[] = [];

function useResource<T>(
  key: string,
  empty: T,
  load: (services: Services) => Promise<Sourced<T>>,
  enabled = true,
): Resource<T> {
  const services = useServices();
  const [attempt, setAttempt] = useState(0);
  const [sourced, setSourced] = useState<Sourced<T> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [inFlight, setInFlight] = useState(enabled);

  /* The loader closes over the current arguments; reading it through a ref keeps
     the effect keyed on the request rather than on a function identity that
     changes every render. */
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!enabled) {
      setInFlight(false);
      return;
    }
    let cancelled = false;
    setInFlight(true);

    void (async () => {
      try {
        const result = await loadRef.current(services);
        if (cancelled) return;
        setSourced(result);
        setError(null);
        setLoadedAt(Date.now());
      } catch (failure) {
        if (cancelled) return;
        setError(failure instanceof Error ? failure.message : 'The service could not be reached.');
      } finally {
        if (!cancelled) setInFlight(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [key, attempt, enabled, services]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  const hasContent = sourced !== null;
  return {
    status: error !== null && !hasContent ? 'error' : hasContent || !inFlight ? 'ready' : 'loading',
    refreshing: inFlight && hasContent,
    data: sourced?.data ?? empty,
    sourced,
    error,
    loadedAt,
    retry,
  };
}

/* -------------------------------------------------------------------------- */
/* Weather                                                                    */
/* -------------------------------------------------------------------------- */

/** The one weather read in the app. The assistant's context is built from it. */
export function useWeather(point: GeoPoint = PROFILE_POINT): Resource<WeatherNow> {
  return useResource<WeatherNow>(
    `weather:${point.lat.toFixed(3)},${point.lon.toFixed(3)}`,
    {
      tempC: null,
      feelsLikeC: null,
      humidityPct: null,
      precipMm: null,
      windKph: null,
      windDir: null,
      conditionText: null,
    },
    (services) => services.weather.current(point),
  );
}

export function useForecast(
  point: GeoPoint = PROFILE_POINT,
  days = 3,
): Resource<WeatherDay[]> {
  return useResource<WeatherDay[]>(
    `forecast:${point.lat.toFixed(3)},${point.lon.toFixed(3)}:${days}`,
    EMPTY as unknown as WeatherDay[],
    (services) => services.weather.forecast(point, days),
  );
}

/* -------------------------------------------------------------------------- */
/* Market                                                                     */
/* -------------------------------------------------------------------------- */

export function useMarketRates(commodity?: string): Resource<MarketRate[]> {
  return useResource<MarketRate[]>(
    `rates:${commodity ?? 'all'}`,
    EMPTY as unknown as MarketRate[],
    (services) => services.market.rates(commodity),
  );
}

/* -------------------------------------------------------------------------- */
/* Dealers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Dealer search.
 *
 * `origin` is present only for a temporary search area. Passing it never changes
 * the farmer's profile location — the provider is told where to look, not who is
 * looking — which is what makes the rule structural rather than a promise.
 */
export function useDealerSearch(query: DealerSearchQuery): Resource<DealerSummary[]> {
  const { radiusKm, query: text, tags, origin } = query;
  const key = [
    'dealers',
    Math.round(radiusKm * 10),
    text?.trim().toLowerCase() ?? '',
    [...(tags ?? [])].sort().join('+'),
    origin ? `${origin.lat.toFixed(3)},${origin.lon.toFixed(3)}` : 'profile',
  ].join(':');

  return useResource<DealerSummary[]>(
    key,
    EMPTY as unknown as DealerSummary[],
    (services) =>
      services.dealer.search({
        radiusKm,
        query: text,
        tags,
        origin,
      }),
  );
}

export function useDealerProducts(dealerId: string | null): Resource<DealerProduct[]> {
  return useResource<DealerProduct[]>(
    `products:${dealerId ?? 'none'}`,
    EMPTY as unknown as DealerProduct[],
    (services) => services.dealer.products(dealerId as string),
    dealerId !== null,
  );
}

/**
 * Where one canonical product can be bought right now.
 *
 * The scan asks this, rather than quoting listings of its own, so the price on a
 * diagnosis is the price on the shop's own page. The key carries the radius and
 * the origin so that pointing the app at a different area is a different request
 * rather than a cached answer about the old one.
 */
export function useStockists(
  canonicalProductId: string,
  radiusKm: number,
  origin?: GeoPoint,
): Resource<DealerStockist[]> {
  const key = [
    'stockists',
    canonicalProductId,
    Math.round(radiusKm * 10),
    origin ? `${origin.lat.toFixed(3)},${origin.lon.toFixed(3)}` : 'profile',
  ].join(':');

  return useResource<DealerStockist[]>(
    key,
    EMPTY as unknown as DealerStockist[],
    (services) => services.dealer.stockists({ canonicalProductId, radiusKm, origin }),
  );
}
