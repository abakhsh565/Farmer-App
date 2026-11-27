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
import { MAX_RADIUS_KM, PROFILE_POINT } from '@/data/dealers';
import { onCatalogChange } from './catalogRealtime';
import { useServices, type Services } from './registry';
import type {
  DealerProduct,
  DealerSearchQuery,
  DealerStockist,
  DealerSummary,
  GeoPoint,
  MarketRate,
  ProductHit,
  ProductSearchQuery,
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

/**
 * How soon a live read asks again.
 *
 * Two mechanisms, in this order.
 *
 * 1. Realtime (`catalogRealtime`) hears the app's own catalogue tables change and
 *    re-reads at once — measured end to end at well under a second.
 * 2. The dealer platform is a different project this app cannot make emit events,
 *    so its live network is re-read on this timer while the screen is visible.
 *    One second is the fallback that keeps a change from ever being more than a
 *    second stale without a socket, and it is skipped entirely while the page is
 *    hidden or the phone is offline.
 */
const LIVE_REFRESH_MS = 1000;

/**
 * One timer for the whole app.
 *
 * Every live read used to own an interval, so three screens' worth of reads fired
 * in three drifting streams — measured at 3.6 requests a second instead of one
 * pass a second — and each one paid its own visibility listeners. They all join
 * this instead: a single tick wakes every mounted live read together, and the
 * timer exists only while something is listening.
 */
const liveReads = new Set<() => void>();
let liveTimer: number | null = null;

function wakeLiveReads() {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  for (const revalidate of liveReads) void revalidate();
}

function joinLiveReads(revalidate: () => void): () => void {
  liveReads.add(revalidate);
  if (liveTimer === null) {
    liveTimer = window.setInterval(wakeLiveReads, LIVE_REFRESH_MS);
    document.addEventListener('visibilitychange', wakeLiveReads);
    window.addEventListener('focus', wakeLiveReads);
    window.addEventListener('online', wakeLiveReads);
  }
  return () => {
    liveReads.delete(revalidate);
    if (liveReads.size === 0 && liveTimer !== null) {
      window.clearInterval(liveTimer);
      liveTimer = null;
      document.removeEventListener('visibilitychange', wakeLiveReads);
      window.removeEventListener('focus', wakeLiveReads);
      window.removeEventListener('online', wakeLiveReads);
    }
  };
}

function useResource<T>(
  key: string,
  empty: T,
  load: (services: Services) => Promise<Sourced<T>>,
  enabled = true,
  /** Keep the answer current on its own, for a read whose source can change. */
  live = false,
): Resource<T> {
  const services = useServices();
  const [attempt, setAttempt] = useState(0);
  /**
   * The last answer *and the request it answers*.
   *
   * Keeping the data without its key was how "4 dealers within 10 km" once named
   * four shops 70–100 km away: the heading read the new radius while the list was
   * still the old answer. An answer is now only shown for the request that asked
   * it — a changed radius or area is a loading state, never a stale list wearing a
   * new label.
   */
  const [sourcedState, setSourcedState] = useState<{ key: string; value: Sourced<T> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [inFlight, setInFlight] = useState(enabled);

  /* The loader closes over the current arguments; reading it through a ref keeps
     the effect keyed on the request rather than on a function identity that
     changes every render. */
  const loadRef = useRef(load);
  loadRef.current = load;

  /** The request on screen, readable from a callback that started earlier. */
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    if (!enabled) {
      /* Disabled is "not asked yet", not "asked and got nothing". Leaving the
         spinner state on is what stops a screen printing "0 dealers" before the
         saved location has even been restored. */
      setInFlight(true);
      return;
    }
    let cancelled = false;
    setInFlight(true);

    void (async () => {
      try {
        const result = await loadRef.current(services);
        if (cancelled) return;
        setSourcedState({ key, value: result });
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

  /*
   * Keeping a live read current.
   *
   * This is deliberately not a second source of truth: it runs the same `load` as
   * the first read, so there is one definition of "what is near the farmer". What it
   * adds is timing — the answer is replaced in place (no loading state, no blank
   * list) as soon as the source says something different, and it stands still while
   * the page is hidden or the phone is offline.
   *
   * An answer is applied only if it still belongs to the request on screen: a tick
   * that was in flight when the radius changed must not paint the old radius's shops
   * under the new heading — the same rule the first read follows.
   */
  useEffect(() => {
    if (!enabled || !live) return;
    let stopped = false;
    let inFlight = false;
    /* A failing source is not asked again on the next tick: a refused key or a
       dropped network would otherwise be hammered once a second. Two ticks off is
       long enough for the connection to come back, short enough not to feel stuck. */
    let cooldown = 0;

    const revalidate = async () => {
      if (stopped || inFlight) return;
      if (cooldown > 0) {
        cooldown -= 1;
        return;
      }
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

      const asked = keyRef.current;
      inFlight = true;
      try {
        const result = await loadRef.current(services);
        if (stopped || keyRef.current !== asked) return;
        setSourcedState({ key: asked, value: result });
        setError(null);
        setLoadedAt(Date.now());
      } catch {
        cooldown = 2;
        /* A failed background read leaves the last answer alone: a shop the farmer
           could still walk to is better than an empty screen, and the next tick — or
           the reconnect — tries again. The first read is what reports a failure. */
      } finally {
        inFlight = false;
      }
    };

    /* The socket makes a synced shop, branch or listing change instant; the timer
       above stays as the fallback for everything it cannot hear. */
    const stopRealtime = onCatalogChange(() => void revalidate());
    const leaveLive = joinLiveReads(revalidate);

    return () => {
      stopped = true;
      stopRealtime();
      leaveLive();
    };
  }, [enabled, live, services]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  const sourced = sourcedState !== null && sourcedState.key === key ? sourcedState.value : null;
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
export function useDealerSearch(
  query: DealerSearchQuery,
  enabled = true,
): Resource<DealerSummary[]> {
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
    enabled,
    /* A dealer opening a branch or approving a product is a change the list has to
       show without the farmer doing anything. */
    true,
  );
}

/**
 * Product search — the same question as dealer search, asked about stock.
 *
 * Keyed like its sibling, on radius, text and origin together: pointing the app at
 * a different area is then a different request rather than a cached answer about
 * the old one, which is the mistake the key exists to make impossible.
 */
export function useProductSearch(
  query: ProductSearchQuery,
  enabled = true,
): Resource<ProductHit[]> {
  const { radiusKm, query: text, origin } = query;
  const key = [
    'product-search',
    Math.round(radiusKm * 10),
    text?.trim().toLowerCase() ?? '',
    origin ? `${origin.lat.toFixed(3)},${origin.lon.toFixed(3)}` : 'profile',
  ].join(':');

  return useResource<ProductHit[]>(
    key,
    EMPTY as unknown as ProductHit[],
    (services) => services.dealer.searchProducts({ radiusKm, query: text, origin }),
    enabled,
    true,
  );
}

/**
 * One dealer, read from the same search the list uses.
 *
 * The profile page is opened with an id and nothing else — from a dealer row, a
 * product page, or a chat — so it has to be able to answer "who is this?" on its
 * own. Asking the dealer service for the widest radius and picking the id keeps
 * the profile reading the *same* projection as the list, which is what stops the
 * two disagreeing about a shop's hours or verification. A shop the service does
 * not return (outside the 100 km ceiling, or withdrawn) resolves to null and the
 * screen says so rather than rendering a page of blanks.
 */
export function useDealer(
  dealerId: string,
  origin?: GeoPoint,
): Resource<DealerSummary | null> {
  return useResource<DealerSummary | null>(
    `dealer:${dealerId}:${origin ? `${origin.lat.toFixed(3)},${origin.lon.toFixed(3)}` : 'profile'}`,
    null,
    async (services) => {
      /*
       * The same origin as the list. Asking with no origin at all left the server
       * to resolve one from the account — which a guest does not have — and the
       * function raised instead of answering, so every shop opened from a guest's
       * list said it was "not in range".
       */
      /* The same reach as the list that opened it. It was hard-coded to 100 km, so a
         shop found at 106 km opened onto "this shop is not in range" — the list and
         the page disagreeing about the same record. */
      const found = await services.dealer.search({ radiusKm: MAX_RADIUS_KM, origin });
      return { ...found, data: found.data.find((dealer) => dealer.id === dealerId) ?? null };
    },
    /* An empty id means "no shop in play" — a product page opened without one
       must not spend a request asking the service who it is. */
    dealerId.length > 0,
    true,
  );
}

export function useDealerProducts(dealerId: string | null): Resource<DealerProduct[]> {
  return useResource<DealerProduct[]>(
    `products:${dealerId ?? 'none'}`,
    EMPTY as unknown as DealerProduct[],
    (services) => services.dealer.products(dealerId as string),
    dealerId !== null,
    /* The shelf changes while the farmer is standing in front of it. */
    true,
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
    true,
    true,
  );
}
