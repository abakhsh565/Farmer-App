/**
 * Remote providers.
 *
 * These talk to the real backend. Note what they talk to, because it is a
 * deliberate architectural choice rather than an implementation detail:
 *
 *   · Weather and market read the *normalised* tables through
 *     `latest_weather()` / `market_rates()`. They do not call WeatherAPI.com or
 *     AMIS directly. The PRD requires that the weather shown in the UI and the
 *     weather used by the AI come from the same normalised service, and that is
 *     only true if neither has its own path to the vendor. It also keeps the
 *     vendor key on the server, where the ingestion function uses it.
 *
 *   · The AI provider calls our own Edge Function, never the model vendor. An
 *     AI key in the client bundle is a key published on the internet.
 *
 *   · Dealers read the read-facing projection, preserving the PRD rule that the
 *     dealer's own system remains the source of truth.
 *
 * The Supabase client is imported dynamically. That keeps it out of the initial
 * bundle for anyone running in development mode, and it means the app still
 * builds and runs with no backend configured.
 */

import type {
  AiAnswer,
  AiContext,
  AiProvider,
  AiScanResult,
  AnalyticsProvider,
  Collection,
  DealerProduct,
  DealerProvider,
  DealerSearchQuery,
  DealerStockist,
  DealerSummary,
  GeoPoint,
  MarketProvider,
  MarketRate,
  OtpChannel,
  OtpProvider,
  OtpRequest,
  OtpVerifyResult,
  Repository,
  Sourced,
  StockistQuery,
  WeatherDay,
  WeatherNow,
  WeatherProvider,
} from '../types';
import { serviceConfig } from '../config';
import type { MessageKey } from '../../i18n/catalog';

/* -------------------------------------------------------------------------- */
/* Supabase client                                                            */
/* -------------------------------------------------------------------------- */

type SupabaseLike = {
  from: (table: string) => unknown;
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
};

let cachedClient: SupabaseLike | null = null;
let clientFailed = false;

/**
 * Lazily creates the client. Returns null rather than throwing when the backend
 * is not configured or the dependency is unavailable, so callers degrade to
 * their development behaviour instead of crashing the screen.
 */
async function supabase(): Promise<SupabaseLike | null> {
  if (cachedClient) return cachedClient;
  if (clientFailed) return null;

  if (!serviceConfig.supabase.configured) return null;

  try {
    // Dynamic so the dependency is code-split and is not required to run the app.
    const mod = await import('@supabase/supabase-js');
    cachedClient = mod.createClient(
      serviceConfig.supabase.url as string,
      serviceConfig.supabase.anonKey as string,
      { auth: { persistSession: true, autoRefreshToken: true } },
    ) as unknown as SupabaseLike;
    return cachedClient;
  } catch {
    clientFailed = true;
    return null;
  }
}

function failing<T>(fallback: T, sourceLabel: string, error: string): Sourced<T> {
  const t = Date.now();
  return { data: fallback, sourceLabel, observedAt: t, fetchedAt: t, freshness: 'unavailable', status: 'failing', error };
}

/* -------------------------------------------------------------------------- */
/* Repository                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Database-backed repository.
 *
 * Writes are revision-checked: `client_document_put` refuses a stale revision, so
 * two devices editing the same document cannot silently overwrite one another.
 * When that happens the write is reported through the returned error rather than
 * swallowed, because a lost write is worse than a visible failure.
 */
export class SupabaseRepository implements Repository {
  readonly name = 'Supabase';
  readonly isRemote = true;

  async read<T>(collection: Collection, ownerId: string): Promise<T | null> {
    const client = await supabase();
    if (!client) return null;

    const { data, error } = await client.rpc('client_document_get', {
      p_owner_id: ownerId,
      p_collection: collection,
    });

    if (error) return null;
    const rows = data as Array<{ document: T }> | null;
    const row = rows?.[0];
    if (!row) return null;
    return row.document;
  }

  async write<T>(collection: Collection, ownerId: string, value: T): Promise<void> {
    const client = await supabase();
    if (!client) return;

    const { error } = await client.rpc('client_document_put', {
      p_owner_id: ownerId,
      p_collection: collection,
      p_document: value as unknown as Record<string, unknown>,
      // Not tracking a revision yet: the stores are still single-device. This
      // becomes a real optimistic-concurrency token when the domain stores move
      // onto their own RPCs, which is the step after this one.
      p_expected_revision: null,
    });

    if (error) {
      throw new Error(`Could not save ${collection}: ${error.message}`);
    }
  }

  async remove(collection: Collection, ownerId: string): Promise<void> {
    const client = await supabase();
    if (!client) return;
    await client.rpc('client_document_delete', { p_owner_id: ownerId, p_collection: collection });
  }
}

/* -------------------------------------------------------------------------- */
/* Weather                                                                    */
/* -------------------------------------------------------------------------- */

type WeatherRow = {
  provider_code: string;
  provider_name: string;
  attribution: string | null;
  observed_at: string;
  age_minutes: number;
  freshness: string;
  is_usable: boolean;
  temp_c: number | null;
  humidity_pct: number | null;
  precip_mm: number | null;
  wind_kph: number | null;
  condition_text: string | null;
};

export class SupabaseWeatherProvider implements WeatherProvider {
  readonly name = 'Supabase normalised weather';

  async current(point: GeoPoint): Promise<Sourced<WeatherNow>> {
    const client = await supabase();
    if (!client) return failing(emptyNow(), this.name, 'Backend is not configured.');

    const { data, error } = await client.rpc('latest_weather', { p_lat: point.lat, p_lon: point.lon });
    if (error) return failing(emptyNow(), this.name, error.message);

    const rows = data as WeatherRow[] | null;
    if (!rows || rows.length === 0) {
      // No row is not an error: it means nobody has fetched for this cell yet.
      // Reported as unavailable so advice pauses, rather than as fresh-and-empty.
      return failing(emptyNow(), this.name, 'No weather has been observed for this location yet.');
    }

    const row = rows[0];
    if (!row) return failing(emptyNow(), this.name, 'No weather has been observed for this location yet.');

    const freshness =
      row.freshness === 'fresh' || row.freshness === 'stale' || row.freshness === 'expired'
        ? row.freshness
        : 'unavailable';

    return {
      data: {
        tempC: row.temp_c,
        feelsLikeC: null,
        humidityPct: row.humidity_pct,
        precipMm: row.precip_mm,
        windKph: row.wind_kph,
        windDir: null,
        conditionText: row.condition_text,
      },
      sourceLabel: row.attribution ?? row.provider_name,
      observedAt: new Date(row.observed_at).getTime(),
      fetchedAt: Date.now(),
      freshness,
      status: row.is_usable ? 'live' : 'failing',
      error: row.is_usable ? undefined : 'The most recent reading is past its usable window.',
    };
  }

  async forecast(): Promise<Sourced<WeatherDay[]>> {
    // Forecast rows are ingested into the same table with kind = 'daily'. Until
    // that ingestion is deployed, an empty forecast is reported honestly rather
    // than fabricated from the current reading.
    return failing([], this.name, 'Forecast ingestion is not deployed yet.');
  }
}

function emptyNow(): WeatherNow {
  return {
    tempC: null,
    feelsLikeC: null,
    humidityPct: null,
    precipMm: null,
    windKph: null,
    windDir: null,
    conditionText: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Market                                                                     */
/* -------------------------------------------------------------------------- */

type MarketRow = {
  commodity_code: string;
  commodity_name_en: string;
  unit: string;
  market_name: string;
  observed_on: string;
  age_hours: number;
  min_price: number | null;
  max_price: number | null;
  modal_price: number | null;
  currency: string;
  source_code: string;
  source_name: string;
  is_recent: boolean;
};

const COMMODITY_KEYS: Record<string, MessageKey> = {
  wheat: 'crop.wheat',
  cotton: 'crop.cotton',
  rice: 'crop.rice',
  maize: 'crop.maize',
};

export class SupabaseMarketProvider implements MarketProvider {
  readonly name = 'Supabase normalised market';

  async rates(commodity?: string): Promise<Sourced<MarketRate[]>> {
    const client = await supabase();
    if (!client) return failing<MarketRate[]>([], this.name, 'Backend is not configured.');

    const { data, error } = await client.rpc('market_rates', {
      p_commodity: commodity ?? null,
      p_max_age_hours: 36,
    });
    if (error) return failing<MarketRate[]>([], this.name, error.message);

    const rows = (data as MarketRow[] | null) ?? [];
    const mapped: MarketRate[] = rows.map((r) => ({
      commodity: r.commodity_code,
      nameEn: r.commodity_name_en,
      nameKey: COMMODITY_KEYS[r.commodity_code],
      unit: r.unit,
      marketName: r.market_name,
      district: null,
      observedOn: r.observed_on,
      // Preserved as NULL. The database already refuses to let a missing price
      // become a zero, and this mapping must not undo that.
      minPrice: r.min_price,
      maxPrice: r.max_price,
      modalPrice: r.modal_price,
      currency: r.currency,
      sourceLabel: r.source_name,
    }));

    const anyRecent = rows.some((r) => r.is_recent);
    const newest = rows.reduce(
      (acc, r) => Math.max(acc, new Date(r.observed_on).getTime()),
      0,
    );

    return {
      data: mapped,
      sourceLabel: rows[0]?.source_name ?? this.name,
      observedAt: newest || Date.now(),
      fetchedAt: Date.now(),
      freshness: anyRecent ? 'fresh' : 'stale',
      status: rows.length === 0 ? 'unconfigured' : 'live',
      error: rows.length === 0 ? 'No market observations have been ingested yet.' : undefined,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Dealers                                                                    */
/* -------------------------------------------------------------------------- */

type DealerRow = {
  dealer_id: string;
  shop_name: string;
  distance_km: number;
  verified_at: string | null;
  opening_hours: string | null;
  sync_state: string;
  synced_at: string | null;
  is_accepting: boolean;
};

type DealerProductRow = {
  id: string;
  name: string;
  brand: string | null;
  category: string | null;
  canonical_product_id: string | null;
  registration_no: string | null;
  pack_size: string | null;
  available_qty: number | null;
  in_stock: boolean | null;
  unit_price: number | null;
  currency: string;
  sync_state: string;
};

type StockistRow = {
  dealer_id: string;
  shop_name: string;
  distance_km: number;
  unit_price: number | null;
  currency: string;
  pack_size: string | null;
  in_stock: boolean | null;
  sync_state: string;
  synced_at: string | null;
};

function syncStateOf(value: string): 'fresh' | 'stale' | 'unreachable' {
  return value === 'fresh' || value === 'stale' ? value : 'unreachable';
}

export class SupabaseDealerProvider implements DealerProvider {
  readonly name = 'Supabase dealer projection';
  readonly maxRadiusKm = 100 as const;

  async search(query: DealerSearchQuery): Promise<Sourced<DealerSummary[]>> {
    const client = await supabase();
    if (!client) return failing<DealerSummary[]>([], this.name, 'Backend is not configured.');

    const { data, error } = await client.rpc('dealers_within_radius', {
      p_farmer_id: null,
      p_lat: query.origin?.lat ?? null,
      p_lon: query.origin?.lon ?? null,
      p_radius_km: Math.min(query.radiusKm, this.maxRadiusKm),
    });
    if (error) return failing<DealerSummary[]>([], this.name, error.message);

    const rows = (data as DealerRow[] | null) ?? [];
    const text = query.query?.trim().toLowerCase() ?? '';

    const mapped: DealerSummary[] = rows
      .map((r) => ({
        id: r.dealer_id,
        name: r.shop_name,
        distanceKm: Number(r.distance_km),
        verifiedAt: r.verified_at ? new Date(r.verified_at).getTime() : null,
        openingHours: r.opening_hours,
        isAcceptingRequests: r.is_accepting,
        syncState: syncStateOf(r.sync_state),
        syncedAt: r.synced_at ? new Date(r.synced_at).getTime() : null,
        tags: [] as readonly string[],
      }))
      .filter((d) => (text.length === 0 ? true : d.name.toLowerCase().includes(text)));

    const newest = rows.reduce(
      (acc, r) => Math.max(acc, r.synced_at ? new Date(r.synced_at).getTime() : 0),
      0,
    );

    return {
      data: mapped,
      sourceLabel: this.name,
      observedAt: newest || Date.now(),
      fetchedAt: Date.now(),
      freshness: rows.some((r) => r.sync_state === 'fresh') ? 'fresh' : 'stale',
      status: 'live',
    };
  }

  async products(dealerId: string): Promise<Sourced<DealerProduct[]>> {
    const client = await supabase();
    if (!client) return failing<DealerProduct[]>([], this.name, 'Backend is not configured.');

    const { data, error } = await client.rpc('dealer_products_for', { p_dealer_id: dealerId });
    if (error) return failing<DealerProduct[]>([], this.name, error.message);

    const rows = (data as DealerProductRow[] | null) ?? [];
    const mapped: DealerProduct[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      brand: r.brand,
      category: r.category,
      canonicalProductId: r.canonical_product_id,
      registrationNo: r.registration_no,
      packSize: r.pack_size,
      // NULL passes through untouched: unknown quantity must not become zero.
      availableQty: r.available_qty,
      inStock: r.in_stock,
      unitPrice: r.unit_price,
      currency: r.currency,
      syncState: syncStateOf(r.sync_state),
    }));

    return {
      data: mapped,
      sourceLabel: this.name,
      observedAt: Date.now(),
      fetchedAt: Date.now(),
      freshness: rows.some((r) => r.sync_state === 'fresh') ? 'fresh' : 'stale',
      status: 'live',
    };
  }

  /**
   * Where a canonical product can be bought, nearest first.
   *
   * One call, because the join and the distance are the database's job: doing it
   * here would mean fetching every dealer and every product to answer a question
   * about one product. `p_lat`/`p_lon` carry the farmer's area when the app knows
   * it; the function falls back to the signed-in farmer's saved location, and a
   * guest with no area on file gets the empty list rather than a wrong one.
   */
  async stockists(query: StockistQuery): Promise<Sourced<DealerStockist[]>> {
    const client = await supabase();
    if (!client) return failing<DealerStockist[]>([], this.name, 'Backend is not configured.');

    const { data, error } = await client.rpc('dealer_stockists_for', {
      p_slug: query.canonicalProductId,
      p_lat: query.origin?.lat ?? null,
      p_lon: query.origin?.lon ?? null,
      p_radius_km: Math.min(query.radiusKm, this.maxRadiusKm),
    });
    if (error) return failing<DealerStockist[]>([], this.name, error.message);

    const rows = (data as StockistRow[] | null) ?? [];
    const mapped: DealerStockist[] = rows.map((r) => ({
      dealerId: r.dealer_id,
      name: r.shop_name,
      distanceKm: Number(r.distance_km),
      // Passed through untouched, including NULL: an unquoted price is not zero.
      unitPrice: r.unit_price,
      currency: r.currency,
      packSize: r.pack_size,
      inStock: r.in_stock,
      syncState: syncStateOf(r.sync_state),
      observedAt: r.synced_at ? new Date(r.synced_at).getTime() : null,
    }));

    const newest = rows.reduce(
      (acc, r) => Math.max(acc, r.synced_at ? new Date(r.synced_at).getTime() : 0),
      0,
    );

    return {
      data: mapped,
      sourceLabel: this.name,
      observedAt: newest || Date.now(),
      fetchedAt: Date.now(),
      freshness: rows.some((r) => r.sync_state === 'fresh') ? 'fresh' : 'stale',
      status: 'live',
    };
  }
}

/* -------------------------------------------------------------------------- */
/* AI                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Calls our own endpoint. The system prompt, the knowledge base and the vendor
 * key all live on the server, so a farmer's device never holds the ability to
 * make the model say something, and the knowledge version cited in an answer
 * cannot differ from the one the server used.
 */
export class RemoteAiProvider implements AiProvider {
  readonly name = 'Server AI gateway';

  constructor(private readonly endpoint = serviceConfig.aiEndpoint.url) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    if (!this.endpoint) throw new Error('AI endpoint is not configured.');

    const response = await fetch(`${this.endpoint}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`AI request failed (${response.status}).`);
    }

    return (await response.json()) as T;
  }

  async ask(question: string, context: AiContext): Promise<AiAnswer> {
    return this.post<AiAnswer>('/ask', { question, context });
  }

  async diagnose(imageRef: string, context: AiContext): Promise<AiScanResult> {
    return this.post<AiScanResult>('/diagnose', { imageRef, context });
  }
}

/* -------------------------------------------------------------------------- */
/* OTP                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * No `developmentCode` here, by design. The type has it optional, so a screen
 * that renders the code compiles against the development provider and fails to
 * have anything to render against this one — which is the point: the "show me the
 * code" affordance cannot silently ship to production.
 */
export class RemoteOtpProvider implements OtpProvider {
  readonly name = 'Server OTP gateway';
  readonly status = 'live' as const;

  constructor(private readonly endpoint = serviceConfig.otpEndpoint.url) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    if (!this.endpoint) throw new Error('OTP endpoint is not configured.');

    const response = await fetch(`${this.endpoint}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) throw new Error(`OTP request failed (${response.status}).`);
    return (await response.json()) as T;
  }

  async request(channel: OtpChannel, destination: string): Promise<OtpRequest> {
    return this.post<OtpRequest>('/request', { channel, destination });
  }

  async verify(channel: OtpChannel, destination: string, code: string): Promise<OtpVerifyResult> {
    return this.post<OtpVerifyResult>('/verify', { channel, destination, code });
  }
}

/* -------------------------------------------------------------------------- */
/* Analytics                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Posts directly to PostHog rather than bundling its SDK.
 *
 * The PRD's analytics need is a handful of product events, and pulling in a full
 * SDK for that would add weight to the APK for feature flags and session replay
 * nothing here uses. The trade-off is explicit: no autocapture, only the events
 * this app chooses to send.
 *
 * Nothing identifying is sent. `identify` takes a party id, which is a random
 * uuid, not a phone number or a name.
 */
export class RemoteAnalyticsProvider implements AnalyticsProvider {
  readonly name = 'PostHog (direct capture)';

  private partyId: string | null = null;

  constructor(
    private readonly key = serviceConfig.analytics.key,
    private readonly host = serviceConfig.analytics.host,
  ) {}

  private send(payload: Record<string, unknown>): void {
    if (!this.key) return;

    // Fire-and-forget. Analytics must never block or break a farmer's task, so
    // failure is deliberately ignored rather than surfaced.
    void fetch(`${this.host}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: this.key, ...payload }),
      keepalive: true,
    }).catch(() => undefined);
  }

  capture(event: string, properties?: Record<string, unknown>): void {
    this.send({
      event,
      properties: { ...properties, distinct_id: this.partyId ?? 'anonymous' },
    });
  }

  identify(partyId: string): void {
    this.partyId = partyId;
    this.send({ event: '$identify', properties: { distinct_id: partyId } });
  }

  reset(): void {
    // No session is kept client-side beyond this reference.
    this.partyId = null;
  }
}
