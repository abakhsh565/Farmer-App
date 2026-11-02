/**
 * Place search.
 *
 * Turns what a farmer types — "Muzaffargarh", "Kot Ladha", "Gujranwala" — into
 * coordinates, so the app can answer "how far is that shop" without asking the
 * farmer to read a latitude off a screen.
 *
 * WHY NOMINATIM, AND WHY IT IS FINE.
 *
 * OpenStreetMap's Nominatim needs no key, no account and no billing, which is
 * the whole reason it is used here: a farmer-facing app should not be unable to
 * ship because an API key has not been approved yet.
 *
 * It is not a service to lean on at scale, and its usage policy is explicit —
 * at most about one request a second, a real application identifier, and no
 * bulk or unattended querying. Three things in this file exist to honour that:
 *
 *   * a minimum query length, so a keystroke does not become a request
 *   * an in-flight de-duplication and cache, so the same term typed twice costs
 *     one request, not two
 *   * results are never prefetched and never retried in a loop
 *
 * If usage ever outgrows that, the swap is one function: a hosted geocoder with
 * the same three properties. Nothing else in the app knows which one answered.
 *
 * This is search only — it resolves names to coordinates. Drawing a map is a
 * separate concern (map tiles) and is deliberately not faked here.
 */

/** A place the farmer can pick, already reduced to what the app needs. */
export type PlaceSuggestion = {
  /** Stable within a session; used as the React key and to avoid refetching. */
  id: string;
  /** Ready to show, e.g. "Muzaffargarh, Punjab, Pakistan". */
  label: string;
  lat: number;
  lon: number;
};

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';

/**
 * Below this length a search is noise: two letters match half of Pakistan and
 * cost a request that Nominatim's policy does not want spent.
 */
const MIN_QUERY_LENGTH = 3;

/** Results a farmer can realistically scroll. More is not more useful. */
const MAX_RESULTS = 8;

type NominatimResult = {
  place_id?: number;
  lat?: string;
  lon?: string;
  display_name?: string;
};

const cache = new Map<string, PlaceSuggestion[]>();
const inFlight = new Map<string, Promise<PlaceSuggestion[]>>();

/** Bounded, so a long session cannot grow the cache without limit. */
const CACHE_LIMIT = 50;

function cacheKey(query: string): string {
  return query.trim().toLowerCase();
}

function remember(key: string, results: PlaceSuggestion[]): void {
  // Re-insert so a frequently used term survives eviction.
  cache.delete(key);
  cache.set(key, results);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

function toSuggestions(payload: NominatimResult[]): PlaceSuggestion[] {
  return payload
    .map((row) => {
      const lat = Number(row.lat);
      const lon = Number(row.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const label = (row.display_name ?? '').trim();
      if (!label) return null;
      return {
        id: row.place_id !== undefined ? String(row.place_id) : `${lat},${lon}`,
        label,
        lat,
        lon,
      };
    })
    .filter((row): row is PlaceSuggestion => row !== null);
}

export type SearchOptions = {
  /** Lets a caller abandon a search when the farmer types another letter. */
  signal?: AbortSignal;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * `accept-language` for the results, in priority order.
   *
   * This is not cosmetic. Asked with no preference, Nominatim answers in the
   * district's own language and returns "مظفر گڑھ, ضلع مظفر گڑھ, پنجاب" — correct,
   * and unreadable to a dealer screen that wants English. So the language is a
   * parameter, and the default asks for Urdu first with English behind it,
   * matching the app's own order of languages.
   */
  language?: string;
};

const DEFAULT_LANGUAGE = 'ur,en';

/**
 * Search for a place in Pakistan.
 *
 * Returns an empty array for a query that is too short, rather than an error:
 * a farmer mid-word is not a failure, and the screen should simply show nothing.
 */
export async function searchPlaces(
  query: string,
  options: SearchOptions = {},
): Promise<PlaceSuggestion[]> {
  const trimmed = query.trim();
  if (trimmed.length < MIN_QUERY_LENGTH) return [];

  const key = cacheKey(trimmed);

  const cached = cache.get(key);
  if (cached) {
    remember(key, cached);
    return cached;
  }

  const alreadyRunning = inFlight.get(key);
  if (alreadyRunning) return alreadyRunning;

  const request = (async (): Promise<PlaceSuggestion[]> => {
    const doFetch = options.fetchImpl ?? fetch;
    const url = new URL(ENDPOINT);
    url.searchParams.set('q', trimmed);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', String(MAX_RESULTS));
    // Pakistan only. Without this, "Muzaffargarh" can return a street in
    // another country with the same name, which is worse than no result.
    url.searchParams.set('countrycodes', 'pk');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('accept-language', options.language ?? DEFAULT_LANGUAGE);

    try {
      const response = await doFetch(url.toString(), {
        signal: options.signal,
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) return [];

      const payload = (await response.json()) as NominatimResult[];
      const results = Array.isArray(payload) ? toSuggestions(payload) : [];
      remember(key, results);
      return results;
    } catch {
      // A failed search must never break the screen the farmer is on. No
      // result is a recoverable state; a thrown error here is not.
      return [];
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, request);
  return request;
}

/** Test seam. Production never needs to clear a cache; tests always do. */
export function clearPlaceCache(): void {
  cache.clear();
  inFlight.clear();
}