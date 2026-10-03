/**
 * Development providers.
 *
 * These are not stubs and they are not "fake UI". The brief is specific: before
 * credentials exist, every approved feature must be functionally executable
 * through a local development implementation that behaves as closely as possible
 * to the real service, so that swapping in the real provider is a configuration
 * change rather than a rewrite.
 *
 * So each provider here implements the full contract, including the behaviour
 * that only shows up when things go wrong:
 *
 *   · weather returns fresh, stale and unreachable readings, so the "advice
 *     paused" path is exercised rather than theorised
 *   · market carries a deliberately stale commodity and a genuinely unreported
 *     price, so NULL-means-unknown is tested rather than assumed
 *   · the AI runs the real pipeline — gate, context, knowledge retrieval,
 *     confidence, citations, escalation — and is deterministic, so tests can
 *     assert an answer instead of tolerating any answer
 *   · OTP has expiry, attempt limits and a resend cooldown, which are the parts
 *     a real provider gets wrong
 *   · the dealer provider does genuine haversine distance with the 100 km
 *     ceiling applied server-side
 *
 * Fixtures live here rather than in the domain layer, on purpose: a coordinate
 * invented for testing is not a fact about a real shop, and putting it beside
 * the domain types is how test data ends up shipped as truth.
 */

import { gate as domainGate } from '../../scan/analyze';
import type { MessageKey } from '../../i18n/catalog';
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
import { AI_CONFIDENCE_THRESHOLD, RATE_MAX_AGE_MS } from '../types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Whether a shop is open, from its own hours and the farmer's clock.
 *
 * Returned as a fact the provider can support rather than a string the screen has
 * to parse: "9am – 8pm" is a label, and turning a label into a decision on the
 * client is how a farmer ends up outside a shut shop.
 */
function isOpenAt(hours: readonly [number, number], at: number): boolean {
  const hour = new Date(at).getHours();
  return hour >= hours[0] && hour < hours[1];
}

/** Distance in km, haversine. Used for real geospatial behaviour locally. */
function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/* -------------------------------------------------------------------------- */
/* Weather                                                                    */
/* -------------------------------------------------------------------------- */

const PROFILE_POINT: GeoPoint = { lat: 32.443, lon: 74.115 };

export class DevelopmentWeatherProvider implements WeatherProvider {
  readonly name = 'Development weather';

  constructor(private readonly now: () => number = Date.now) {}

  async current(point: GeoPoint): Promise<Sourced<WeatherNow>> {
    const t = this.now();
    const far = haversineKm(point, PROFILE_POINT) > 25;

    // The remote half of the fixture exists so the unavailable state is a real
    // code path in development, not something first discovered in production.
    if (far) {
      return {
        data: emptyWeatherNow(),
        sourceLabel: this.name,
        observedAt: t,
        fetchedAt: t,
        freshness: 'unavailable',
        status: 'failing',
        error: 'No reading for this location in the development fixture.',
      };
    }

    return {
      data: {
        tempC: 34.5,
        feelsLikeC: 38.1,
        humidityPct: 42,
        precipMm: 0,
        windKph: 11.2,
        windDir: 'SW',
        conditionText: 'Clear',
        conditionKey: 'weather.condition',
      },
      sourceLabel: this.name,
      observedAt: t - 12 * MINUTE,
      fetchedAt: t,
      freshness: 'fresh',
      status: 'development',
    };
  }

  // The fixture is not location-dependent, so the point is accepted for
  // signature parity with the real provider and deliberately unused.
  async forecast(_point: GeoPoint, days: number): Promise<Sourced<WeatherDay[]>> {
    const t = this.now();
    const out: WeatherDay[] = [];
    for (let i = 0; i < Math.max(0, Math.min(days, 10)); i += 1) {
      const date = new Date(t + i * DAY).toISOString().slice(0, 10);
      out.push({
        date,
        minC: 24 + i,
        maxC: 35 + i,
        precipMm: i % 3 === 0 ? 0 : 1.4,
        conditionText: i % 3 === 0 ? 'Clear' : 'Light rain',
      });
    }

    return {
      data: out,
      sourceLabel: this.name,
      observedAt: t - 30 * MINUTE,
      fetchedAt: t,
      freshness: 'fresh',
      status: 'development',
    };
  }
}

function emptyWeatherNow(): WeatherNow {
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

/**
 * AMIS-shaped development records.
 *
 * `maize` is deliberately older than the freshness window, and `onion` has a
 * genuinely unreported `minPrice`. Those two rows are the point of the fixture:
 * without them, "never present a stale rate as current" and "never turn a
 * missing value into zero" are untestable claims.
 */
const MARKET_FIXTURE: ReadonlyArray<Omit<MarketRate, 'sourceLabel'>> = [
  {
    commodity: 'wheat',
    nameEn: 'Wheat',
    nameKey: 'crop.wheat' satisfies MessageKey,
    unit: '40kg',
    marketName: 'Wazirabad',
    district: 'Gujranwala',
    observedOn: new Date(Date.now() - 5 * HOUR).toISOString(),
    minPrice: 3900,
    maxPrice: 4050,
    modalPrice: 3980,
    currency: 'PKR',
  },
  {
    commodity: 'cotton',
    nameEn: 'Cotton',
    nameKey: 'crop.cotton' satisfies MessageKey,
    unit: '40kg',
    marketName: 'Wazirabad',
    district: 'Gujranwala',
    observedOn: new Date(Date.now() - 9 * HOUR).toISOString(),
    minPrice: 8100,
    maxPrice: 8450,
    modalPrice: 8300,
    currency: 'PKR',
  },
  {
    // Stale by design: older than RATE_MAX_AGE_MS, so the "never show a stale
    // rate as current" path is exercised rather than assumed.
    commodity: 'maize',
    nameEn: 'Maize',
    nameKey: 'crop.maize' satisfies MessageKey,
    unit: '40kg',
    marketName: 'Gujranwala',
    district: 'Gujranwala',
    observedOn: new Date(Date.now() - 5 * DAY).toISOString(),
    minPrice: 2750,
    maxPrice: 2900,
    modalPrice: 2820,
    currency: 'PKR',
  },
  {
    // minPrice unreported by the source. NULL, never 0 — the other half of the
    // market rule, and the reason `rateRange` returns null rather than 0 – 0.
    commodity: 'rice',
    nameEn: 'Rice',
    nameKey: 'crop.rice' satisfies MessageKey,
    unit: '40kg',
    marketName: 'Hafizabad',
    district: 'Hafizabad',
    observedOn: new Date(Date.now() - 20 * HOUR).toISOString(),
    minPrice: null,
    maxPrice: 3400,
    modalPrice: 3250,
    currency: 'PKR',
  },
];

export class DevelopmentMarketProvider implements MarketProvider {
  readonly name = 'Development market (AMIS-shaped)';

  constructor(private readonly now: () => number = Date.now) {}

  async rates(commodity?: string): Promise<Sourced<MarketRate[]>> {
    const t = this.now();
    const rows = MARKET_FIXTURE.filter((r) => !commodity || r.commodity === commodity).map((r) => ({
      ...r,
      sourceLabel: this.name,
    }));

    const newest = rows.reduce((acc, r) => Math.max(acc, new Date(r.observedOn).getTime()), 0);

    return {
      data: rows,
      sourceLabel: this.name,
      observedAt: newest || t,
      fetchedAt: t,
      // The collection freshness follows the newest row; individual rows are
      // still checked with isRateQuotable, because a batch can mix ages.
      freshness: newest && t - newest <= RATE_MAX_AGE_MS ? 'fresh' : 'stale',
      status: 'development',
    };
  }
}

/* -------------------------------------------------------------------------- */
/* AI                                                                         */
/* -------------------------------------------------------------------------- */

type KnowledgeEntry = {
  id: string;
  version: number;
  cropCode: string | null;
  topic: string;
  keywords: readonly string[];
  answer: string;
  provenance: string;
};

/**
 * A small, deliberately limited knowledge base.
 *
 * The insufficiency is the feature. A question whose keywords match nothing must
 * come back `not_covered` with a low confidence and an escalation, because that
 * is exactly what the real provider must do when the published knowledge does not
 * cover something — and it is the behaviour that would otherwise be discovered
 * late, against a live model, by a farmer.
 */
const KNOWLEDGE: readonly KnowledgeEntry[] = [
  {
    id: 'cotton-pink-bollworm',
    version: 3,
    cropCode: 'cotton',
    topic: 'pest',
    keywords: ['pink bollworm', 'گلابی سنڈی', 'bollworm', 'cotton pest'],
    answer:
      'Pink bollworm is managed by destroying infested bolls, avoiding late sowing, and rotating the mode of action between sprays so resistance does not build up. Confirm the pest on the plant before spraying.',
    provenance: 'Extension bulletin, reviewed',
  },
  {
    id: 'wheat-sowing-window',
    version: 2,
    cropCode: 'wheat',
    topic: 'agronomy',
    keywords: ['wheat sowing', 'گندم', 'sowing time', 'late sowing'],
    answer:
      'Wheat yields fall sharply with late sowing. Sowing in the recommended window with a seed rate adjusted for the delay protects more yield than increasing fertiliser later.',
    provenance: 'Extension bulletin, reviewed',
  },
  {
    id: 'spray-wind',
    version: 1,
    cropCode: null,
    topic: 'safety',
    keywords: ['spray', 'wind', 'safety', 'drift'],
    answer:
      'Spray when the wind is light and steady. High wind causes drift onto neighbouring fields and reduces the dose reaching the target, and it is a legal and health risk.',
    provenance: 'Extension bulletin, reviewed',
  },
];

function scoreByKeywords(question: string, entry: KnowledgeEntry): number {
  const q = question.toLowerCase();
  const hits = entry.keywords.filter((k) => q.includes(k.toLowerCase())).length;
  return hits === 0 ? 0 : hits / entry.keywords.length;
}

export class DevelopmentAiProvider implements AiProvider {
  readonly name = 'Development AI (deterministic)';

  async ask(question: string, context: AiContext): Promise<AiAnswer> {
    const verdict = domainGate(question);
    if (verdict !== 'agriculture') {
      return {
        gate: verdict,
        confidence: 0,
        refusalReasonKey: verdict === 'off_domain' ? 'scan.offDomain.title' : 'scan.notCovered.title',
        citations: [],
        escalate: false,
        caveats: [],
      };
    }

    const ranked = KNOWLEDGE.map((entry) => ({ entry, score: scoreByKeywords(question, entry) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);

    const caveats: string[] = [];

    // The weather caveat is the reason `weatherUsable` is on the context: advice
    // that depends on conditions must say so rather than quietly assume them.
    const mentionsWeather = /spray|wind|irrigat/i.test(question);
    if (mentionsWeather && context.weatherUsable === false) {
      caveats.push('Current weather could not be read, so this advice is not adjusted for today’s conditions.');
    }

    const [best] = ranked;

    if (!best) {
      return {
        gate: 'not_covered',
        confidence: 20,
        refusalReasonKey: 'scan.notCovered.title',
        citations: [],
        escalate: true,
        caveats,
      };
    }

    const confidence = Math.round(
      Math.min(92, 55 + best.score * 35 + (context.cropCode === best.entry.cropCode ? 5 : 0)),
    );

    return {
      gate: 'agriculture',
      confidence,
      text: best.entry.answer,
      citations: [{ kind: 'knowledge', label: best.entry.topic, version: best.entry.version }],
      escalate: confidence < AI_CONFIDENCE_THRESHOLD,
      caveats,
    };
  }

  async diagnose(_imageRef: string, context: AiContext): Promise<AiScanResult> {
    // Deterministic: the development provider always reports the same disease for
    // cotton, so a test can assert it rather than accept whatever comes back.
    const isCotton = context.cropCode === 'cotton';

    if (!isCotton) {
      return {
        gate: 'not_covered',
        diagnosis: null,
        confidence: 25,
        uncertaintyKey: 'scan.notCovered.title',
        citations: [],
        escalate: true,
      };
    }

    return {
      gate: 'agriculture',
      diagnosis: 'Pink bollworm (گلابی سنڈی)',
      confidence: 78,
      uncertaintyKey: null,
      product: {
        canonicalId: 'roundup',
        name: 'Roundup',
        registrationNo: 'DPP-PK-2019-0431',
        listingDealerIds: ['ali-traders', 'kisan-store'],
      },
      citations: [
        { kind: 'knowledge', label: 'cotton-pink-bollworm', version: 3 },
        { kind: 'crop_fact', label: 'cotton, flowering' },
      ],
      escalate: false,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* OTP                                                                        */
/* -------------------------------------------------------------------------- */

type OtpRecord = {
  code: string;
  expiresAt: number;
  attempts: number;
  lastSentAt: number;
};

const OTP_TTL_MS = 5 * MINUTE;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_S = 30;

export class DevelopmentOtpProvider implements OtpProvider {
  readonly name = 'Development OTP';
  readonly status = 'development' as const;

  private readonly issued = new Map<string, OtpRecord>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {}

  private key(channel: OtpChannel, destination: string): string {
    return `${channel}:${destination}`;
  }

  async request(channel: OtpChannel, destination: string): Promise<OtpRequest> {
    const t = this.now();
    const key = this.key(channel, destination);
    const existing = this.issued.get(key);

    if (existing && t - existing.lastSentAt < OTP_RESEND_COOLDOWN_S * 1000) {
      // Re-issue the same code rather than a new one: sending a second code while
      // the first is valid is how a user ends up entering the wrong one.
      return {
        channel,
        destination,
        deliveredVia: 'development',
        expiresAt: existing.expiresAt,
        resendAfterSeconds: Math.ceil(
          (OTP_RESEND_COOLDOWN_S * 1000 - (t - existing.lastSentAt)) / 1000,
        ),
        developmentCode: existing.code,
      };
    }

    const code = String(Math.floor(this.random() * 900000) + 100000);
    const record: OtpRecord = { code, expiresAt: t + OTP_TTL_MS, attempts: 0, lastSentAt: t };
    this.issued.set(key, record);

    return {
      channel,
      destination,
      deliveredVia: 'development',
      expiresAt: record.expiresAt,
      resendAfterSeconds: OTP_RESEND_COOLDOWN_S,
      // Present ONLY in the development provider. The remote implementation has
      // no such field, so a screen cannot depend on it without failing to
      // compile against the real provider.
      developmentCode: code,
    };
  }

  async verify(channel: OtpChannel, destination: string, code: string): Promise<OtpVerifyResult> {
    const t = this.now();
    const key = this.key(channel, destination);
    const record = this.issued.get(key);

    if (!record) return { ok: false, reason: 'unknown' };

    if (t > record.expiresAt) {
      this.issued.delete(key);
      return { ok: false, reason: 'expired' };
    }

    if (record.attempts >= OTP_MAX_ATTEMPTS) {
      this.issued.delete(key);
      return { ok: false, reason: 'too_many_attempts' };
    }

    if (record.code !== code.trim()) {
      record.attempts += 1;
      this.issued.set(key, record);
      return { ok: false, reason: 'mismatch' };
    }

    // Single use.
    this.issued.delete(key);
    return { ok: true };
  }
}

/* -------------------------------------------------------------------------- */
/* Dealers                                                                    */
/* -------------------------------------------------------------------------- */

type DealerFixture = {
  id: string;
  name: string;
  point: GeoPoint;
  tags: readonly string[];
  verifiedDaysAgo: number | null;
  openingHours: string;
  /** Opening and closing hour, so "open now" is computed rather than asserted. */
  hours: readonly [number, number];
  accepting: boolean;
  yours?: boolean;
  syncState: 'fresh' | 'stale' | 'unreachable';
  syncedHoursAgo: number;
};

/**
 * Placing a shop at a distance from the profile.
 *
 * The distance the product shows is computed from coordinates, so the fixtures
 * have to be *placed* at a distance rather than declared to be one. This is the
 * difference that matters: with the shops positioned for real, moving the search
 * area moves every distance (which is the rule the temporary-area feature exists
 * for), and a shop beyond the ceiling cannot be reached by loosening the filter,
 * because the filter never sees it.
 */
const KM_PER_LAT_DEGREE = 110.574;
const KM_PER_LON_DEGREE = 111.32 * Math.cos((PROFILE_POINT.lat * Math.PI) / 180);

function atDistanceKm(km: number, northShare: number): GeoPoint {
  const eastShare = Math.sqrt(Math.max(0, 1 - northShare * northShare));
  return {
    lat: Number((PROFILE_POINT.lat + (km * northShare) / KM_PER_LAT_DEGREE).toFixed(6)),
    lon: Number((PROFILE_POINT.lon + (km * eastShare) / KM_PER_LON_DEGREE).toFixed(6)),
  };
}

const DEALER_FIXTURE: readonly DealerFixture[] = [
  { id: 'dealer.aliTraders', name: 'Ali Traders', point: atDistanceKm(1.8, 0.9), tags: ['pesticide', 'fertilizer'], verifiedDaysAgo: 21, openingHours: '9am – 8pm', hours: [9, 20], accepting: true, yours: true, syncState: 'fresh', syncedHoursAgo: 2 },
  { id: 'dealer.greenAgro', name: 'Green Agro Store', point: atDistanceKm(3.4, 0.35), tags: ['fertilizer', 'cotton'], verifiedDaysAgo: 48, openingHours: '8am – 7pm', hours: [8, 19], accepting: true, syncState: 'fresh', syncedHoursAgo: 4 },
  /* A shop whose stock projection is two days old: the "this may be out of date"
     path, which is exactly what a farmer needs told rather than hidden. */
  { id: 'dealer.wazirabadAgri', name: 'Wazirabad Agri Center', point: atDistanceKm(4.1, -0.2), tags: ['seed', 'pesticide'], verifiedDaysAgo: 90, openingHours: '9am – 9pm', hours: [9, 21], accepting: true, syncState: 'stale', syncedHoursAgo: 50 },
  /* Never verified: the row must not wear a verification badge. */
  { id: 'dealer.malikFertilizers', name: 'Malik Fertilizers', point: atDistanceKm(5.6, 0.6), tags: ['fertilizer'], verifiedDaysAgo: null, openingHours: '8am – 6pm', hours: [8, 18], accepting: false, syncState: 'fresh', syncedHoursAgo: 3 },
  /* Not reached for four days: availability from this shop is unknowable. */
  { id: 'dealer.punjabSeed', name: 'Punjab Seed Corner', point: atDistanceKm(6.2, -0.7), tags: ['seed', 'cotton'], verifiedDaysAgo: 12, openingHours: '10am – 6pm', hours: [10, 18], accepting: true, syncState: 'unreachable', syncedHoursAgo: 96 },
  /*
   * 112 km away: past the product's hard ceiling. It exists so the boundary is
   * testable from the top — at the maximum radius the list must still not contain
   * it, which is only provable if there is something on the other side of the line.
   */
  { id: 'dealer.farMandi', name: 'Far Mandi Depot', point: atDistanceKm(112, 0.99), tags: ['fertilizer'], verifiedDaysAgo: 30, openingHours: '9am – 7pm', hours: [9, 19], accepting: true, syncState: 'fresh', syncedHoursAgo: 1 },
];

const DEALER_PRODUCTS: Readonly<Record<string, readonly DealerProduct[]>> = {
  'dealer.aliTraders': [
    { id: 'ali-roundup', name: 'Roundup', brand: 'Bayer', category: 'herbicide', canonicalProductId: 'roundup', registrationNo: 'DPP-PK-2019-0431', packSize: '1 L', availableQty: 14, inStock: true, unitPrice: 1850, currency: 'PKR', syncState: 'fresh' },
    /* Quantity not reported by the dealer system — unknown, never zero. */
    { id: 'ali-confidor', name: 'Confidor', brand: 'Bayer', category: 'pesticide', canonicalProductId: 'confidor', registrationNo: 'DPP-PK-2017-0228', packSize: '250 ml', availableQty: null, inStock: null, unitPrice: 1420, currency: 'PKR', syncState: 'fresh' },
  ],
  'dealer.greenAgro': [
    /* Confirmed none. The opposite of the row above, and it must look different. */
    { id: 'green-urea', name: 'Urea', brand: null, category: 'fertilizer', canonicalProductId: 'urea', registrationNo: null, packSize: '50 kg', availableQty: 0, inStock: false, unitPrice: 4600, currency: 'PKR', syncState: 'fresh' },
    /* The same product as Ali Traders carries, at this shop's own price: two live
       listings for one canonical product, which is what a scan result shows. */
    { id: 'green-roundup', name: 'Roundup', brand: 'Bayer', category: 'herbicide', canonicalProductId: 'roundup', registrationNo: 'DPP-PK-2019-0431', packSize: '1 L', availableQty: 6, inStock: true, unitPrice: 1880, currency: 'PKR', syncState: 'fresh' },
  ],
  'dealer.punjabSeed': [
    { id: 'punjab-btcotton', name: 'Bt cotton seed', brand: null, category: 'seed', canonicalProductId: 'bt-cotton-seed', registrationNo: 'DPP-PK-2020-0117', packSize: '1 kg', availableQty: 22, inStock: true, unitPrice: 1250, currency: 'PKR', syncState: 'unreachable' },
  ],
};

export class DevelopmentDealerProvider implements DealerProvider {
  readonly name = 'Development dealer directory';
  readonly maxRadiusKm = 100 as const;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly profilePoint: GeoPoint = PROFILE_POINT,
  ) {}

  async search(query: DealerSearchQuery): Promise<Sourced<DealerSummary[]>> {
    const t = this.now();
    const origin = query.origin ?? this.profilePoint;

    // The ceiling is applied here as well as in the UI, so the rule survives a
    // caller that forgets it.
    const radius = Math.min(Math.max(query.radiusKm, 1), this.maxRadiusKm);
    const text = query.query?.trim().toLowerCase() ?? '';

    const rows: DealerSummary[] = DEALER_FIXTURE.map((d) => ({
      id: d.id,
      name: d.name,
      distanceKm: Number(haversineKm(origin, d.point).toFixed(1)),
      verifiedAt: d.verifiedDaysAgo === null ? null : t - d.verifiedDaysAgo * DAY,
      openingHours: d.openingHours,
      /* Computed from the shop's own hours against the farmer's clock, so the
         "open now" line is a fact the source can support. */
      openNow: isOpenAt(d.hours, t),
      isAcceptingRequests: d.accepting,
      isYourDealer: d.yours === true,
      syncState: d.syncState,
      syncedAt: t - d.syncedHoursAgo * HOUR,
      tags: d.tags,
    }))
      .filter((d) => d.distanceKm <= radius)
      .filter((d) => (query.tags?.length ? query.tags.every((tag) => d.tags.includes(tag)) : true))
      .filter((d) =>
        text.length === 0
          ? true
          : d.name.toLowerCase().includes(text) || d.tags.some((tag) => tag.includes(text)),
      )
      .sort((a, b) => a.distanceKm - b.distanceKm);

    return {
      data: rows,
      sourceLabel: this.name,
      observedAt: t,
      fetchedAt: t,
      freshness: 'fresh',
      status: 'development',
    };
  }

  async products(dealerId: string): Promise<Sourced<DealerProduct[]>> {
    const t = this.now();
    const fixture = DEALER_FIXTURE.find((d) => d.id === dealerId);
    const rows = [...(DEALER_PRODUCTS[dealerId] ?? [])];

    return {
      data: rows,
      sourceLabel: this.name,
      observedAt: t,
      fetchedAt: t,
      // A dealer whose projection is stale reports stale here, so the screen has
      // something truthful to show instead of inventing availability.
      freshness: fixture && fixture.syncState === 'fresh' ? 'fresh' : 'stale',
      status: fixture && fixture.syncState === 'unreachable' ? 'failing' : 'development',
      error: fixture?.syncState === 'unreachable' ? 'The dealer system could not be reached.' : undefined,
    };
  }

  /**
   * Which shops have this product, nearest first.
   *
   * The listings come from the same fixtures as each shop's own product list, so
   * the price a farmer reads on a scan result is the price on the shop's page.
   * They used to be written next to the treatment, and the two disagreed — the
   * scan quoting Ali Traders' Roundup at one price while Ali Traders' own page
   * quoted another.
   *
   * A shop that has confirmed it is out is not a place to send a farmer, so those
   * rows are dropped. A shop whose stock is *unknown* stays, marked as such: it may
   * well have the product, and hiding it would answer a question the source did not.
   */
  async stockists(query: StockistQuery): Promise<Sourced<DealerStockist[]>> {
    const t = this.now();
    const origin = query.origin ?? this.profilePoint;
    const radius = Math.min(Math.max(query.radiusKm, 1), this.maxRadiusKm);

    const rows = DEALER_FIXTURE.map((d): DealerStockist | null => {
      const listing = (DEALER_PRODUCTS[d.id] ?? []).find(
        (product) =>
          product.canonicalProductId === query.canonicalProductId && product.inStock !== false,
      );
      if (!listing) return null;

      return {
        dealerId: d.id,
        name: d.name,
        distanceKm: Number(haversineKm(origin, d.point).toFixed(1)),
        unitPrice: listing.unitPrice,
        currency: listing.currency,
        packSize: listing.packSize,
        inStock: listing.inStock,
        syncState: d.syncState,
        // When the shop's projection was last confirmed, which is what the
        // freshness line on the scan result reports.
        observedAt: t - d.syncedHoursAgo * HOUR,
      };
    })
      .filter((row): row is DealerStockist => row !== null)
      .filter((row) => row.distanceKm <= radius)
      .sort((a, b) => a.distanceKm - b.distanceKm);

    return {
      data: rows,
      sourceLabel: this.name,
      observedAt: t,
      fetchedAt: t,
      freshness: 'fresh',
      status: 'development',
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Analytics                                                                  */
/* -------------------------------------------------------------------------- */

export class DevelopmentAnalyticsProvider implements AnalyticsProvider {
  readonly name = 'Development analytics';
  /** Kept in memory so tests can assert what would have been sent. */
  readonly events: Array<{ event: string; properties?: Record<string, unknown> }> = [];

  capture(event: string, properties?: Record<string, unknown>): void {
    this.events.push({ event, properties });
  }

  identify(): void {
    /* no-op: nothing leaves the device */
  }

  reset(): void {
    this.events.length = 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Repository                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The development repository.
 *
 * Every read and write is async, even though localStorage is synchronous. That
 * is deliberate: a synchronous local repository would let a screen depend on
 * data being available immediately, and that dependency would only break on the
 * day the Supabase repository replaced it.
 */
export class LocalRepository implements Repository {
  readonly name = 'Local device storage';
  readonly isRemote = false;

  constructor(private readonly keyPrefix = 'agri-shop') {}

  private key(collection: Collection, ownerId: string): string {
    return `${this.keyPrefix}.${collection}.${ownerId}`;
  }

  async read<T>(collection: Collection, ownerId: string): Promise<T | null> {
    try {
      const raw = localStorage.getItem(this.key(collection, ownerId));
      if (raw === null) return null;
      return JSON.parse(raw) as T;
    } catch {
      // A corrupt or unreadable document is treated as absent rather than as a
      // crash: the app must still open, and the caller decides what to seed.
      return null;
    }
  }

  async write<T>(collection: Collection, ownerId: string, value: T): Promise<void> {
    try {
      localStorage.setItem(this.key(collection, ownerId), JSON.stringify(value));
    } catch {
      /* storage full or unavailable — the session continues in memory */
    }
  }

  async remove(collection: Collection, ownerId: string): Promise<void> {
    try {
      localStorage.removeItem(this.key(collection, ownerId));
    } catch {
      /* nothing to do */
    }
  }
}
