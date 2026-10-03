/**
 * Service contracts.
 *
 * Every external dependency the app has is described here as an interface, so
 * that the screens and stores depend on a *capability* rather than on a vendor.
 * The PRD requires two things that this file is the answer to:
 *
 *   · "Do not hard-code the application to the provider" (weather, and by
 *     extension every other provider)
 *   · the UI and the AI must read the same normalised service, so that they can
 *     never disagree about the number in front of the farmer
 *
 * Each contract carries its own provenance: a source label and an observation
 * time. That is not decoration. The PRD forbids presenting stale information as
 * current and forbids inventing a missing value, and both rules are only
 * checkable if the metadata travels with the data.
 *
 * Implementations live in `./providers/develop` (complete behaviour on local
 * data, no credentials needed) and `./providers/remote` (the real vendor, which
 * activates when its key exists). Swapping one for the other is a configuration
 * change; no screen or store changes.
 */

import type { MessageKey } from '../i18n/catalog';

/** How stale a reading is, stated once so UI and advice cannot disagree. */
export type Freshness = 'fresh' | 'stale' | 'expired' | 'unavailable';

/** What the provider layer reports about its own health, surfaced in the UI. */
export type ProviderStatus = 'live' | 'development' | 'unconfigured' | 'failing';

export type Sourced<T> = {
  data: T;
  /** Named provider, e.g. 'WeatherAPI.com' or 'Development fixture'. */
  sourceLabel: string;
  /** When the underlying value was observed, not when it was fetched. */
  observedAt: number;
  fetchedAt: number;
  freshness: Freshness;
  status: ProviderStatus;
  /** Present when the provider could not be reached. Drives the error state. */
  error?: string;
};

export type GeoPoint = { lat: number; lon: number };

/* -------------------------------------------------------------------------- */
/* Weather                                                                    */
/* -------------------------------------------------------------------------- */

export type WeatherNow = {
  tempC: number | null;
  feelsLikeC: number | null;
  humidityPct: number | null;
  precipMm: number | null;
  windKph: number | null;
  windDir: string | null;
  /** The condition as the provider words it. Always present when there is one. */
  conditionText: string | null;
  /**
   * The translated condition, when the app has a word for it.
   *
   * A real provider returns its own vocabulary — "Partly cloudy", "Light rain" —
   * which cannot be translated on the client. A catalogue key is set when the
   * wording is one the app already knows, and the screen prefers it, so the card
   * is not half English in Urdu. Same shape as the market feed's commodity names.
   */
  conditionKey?: MessageKey;
};

export type WeatherDay = {
  date: string;
  minC: number | null;
  maxC: number | null;
  precipMm: number | null;
  conditionText: string | null;
};

export interface WeatherProvider {
  readonly name: string;
  /** Current conditions. Never throws: a failure is reported inside the result. */
  current(point: GeoPoint): Promise<Sourced<WeatherNow>>;
  forecast(point: GeoPoint, days: number): Promise<Sourced<WeatherDay[]>>;
}

/**
 * The gate the advice engine must consult.
 *
 * A separate, synchronous function rather than a boolean on the reading, because
 * the decision "is advice allowed to use this" must be answerable without a
 * network call and must have exactly one implementation.
 */
export function isWeatherUsable(reading: Sourced<WeatherNow>): boolean {
  return reading.status !== 'failing' && reading.error === undefined && reading.freshness === 'fresh';
}

/**
 * The other half of the same decision: there is a reading, but it is too old to
 * spray on.
 *
 * Separate from `isWeatherUsable` because the screen must say "out of date" for
 * this and "not available" for a failed call. Both pause the advice; they must
 * not share a sentence, and a failed call also returns a reading (with no
 * numbers in it), so truthiness cannot tell them apart — only freshness can.
 */
export function isWeatherStale(reading: Sourced<WeatherNow>): boolean {
  return reading.freshness === 'stale';
}

/* -------------------------------------------------------------------------- */
/* Market                                                                     */
/* -------------------------------------------------------------------------- */

export type MarketRate = {
  commodity: string;
  /**
   * Message key for the display name when the catalogue has one.
   *
   * Optional because the catalogue only carries keys for four crops today, and
   * inventing a key to satisfy a type would put the wrong word in front of a
   * farmer. The UI prefers `nameKey` and falls back to `nameEn`, which is the
   * commodity name as the source reports it.
   */
  nameKey?: MessageKey;
  /** The commodity name as the source reports it. Always present. */
  nameEn: string;
  unit: string;
  marketName: string;
  district: string | null;
  observedOn: string;
  /**
   * All three are nullable. NULL means "the source did not report it" and is
   * never coerced to zero, because zero is a price a farmer can be offered.
   */
  minPrice: number | null;
  maxPrice: number | null;
  modalPrice: number | null;
  currency: string;
  sourceLabel: string;
};

export interface MarketProvider {
  readonly name: string;
  rates(commodity?: string): Promise<Sourced<MarketRate[]>>;
}

/** A rate is only quotable while it is inside the freshness window. */
export const RATE_MAX_AGE_MS = 36 * 60 * 60 * 1000;

export function isRateQuotable(rate: MarketRate, now: number): boolean {
  const age = now - new Date(rate.observedOn).getTime();
  return Number.isFinite(age) && age <= RATE_MAX_AGE_MS;
}

/**
 * The honest summary line for a set of rates: a range only when a range was
 * actually reported. Returns null when nothing quotable exists, so a caller
 * cannot accidentally render an empty range as `0 – 0`.
 */
export function rateRange(rates: readonly MarketRate[]): { min: number; max: number } | null {
  const mins = rates.map((r) => r.minPrice).filter((v): v is number => v !== null);
  const maxes = rates.map((r) => r.maxPrice).filter((v): v is number => v !== null);
  if (mins.length === 0 || maxes.length === 0) return null;
  return { min: Math.min(...mins), max: Math.max(...maxes) };
}

/* -------------------------------------------------------------------------- */
/* AI                                                                         */
/* -------------------------------------------------------------------------- */

/** The agricultural domain gate. Off-domain questions are refused, not answered. */
export type AiGate = 'agriculture' | 'off_domain' | 'not_covered';

export type AiContext = {
  /** Confirmed crop facts only. Inferences are passed separately, and labelled. */
  cropCode?: string;
  cropStage?: string;
  district?: string;
  language: string;
  /** Freshness of the weather the answer may cite. */
  weatherUsable?: boolean;
  /** Recent behaviour, already weighted. Relevance only, never asserted as fact. */
  signalSubjects?: string[];
};

export type AiCitation = {
  kind: 'knowledge' | 'weather' | 'market' | 'crop_fact' | 'scan';
  label: string;
  /** Version of the knowledge entry, when the citation is knowledge. */
  version?: number;
};

export type AiAnswer = {
  gate: AiGate;
  /**
   * Confidence as a percentage. Below the escalation threshold the UI must show
   * the uncertainty line rather than a confident answer.
   */
  confidence: number;
  /** The answer text. Absent when the gate refused. */
  text?: string;
  /** Why the gate refused, when it did. */
  refusalReasonKey?: MessageKey;
  citations: AiCitation[];
  /** True when the answer must be escalated to a human expert. */
  escalate: boolean;
  /** Anything the answer could not rely on, stated rather than hidden. */
  caveats: string[];
};

export type AiScanResult = {
  gate: AiGate;
  diagnosis: string | null;
  confidence: number;
  /** The uncertainty sentence the UI must show above the answer. */
  uncertaintyKey: MessageKey | null;
  /** Product evidence chain: canonical product plus where to buy it. */
  product?: {
    canonicalId: string;
    name: string;
    registrationNo: string | null;
    listingDealerIds: string[];
  };
  citations: AiCitation[];
  escalate: boolean;
};

export interface AiProvider {
  readonly name: string;
  /** Conversational question answering, knowledge-grounded. */
  ask(question: string, context: AiContext): Promise<AiAnswer>;
  /** Image diagnosis. `imageRef` is a media asset id or a data URL. */
  diagnose(imageRef: string, context: AiContext): Promise<AiScanResult>;
}

/**
 * Below this, the answer is presented as uncertain and a human hand-off is
 * offered. Kept here, next to the contract, because it is a product rule about
 * honesty rather than a tuning constant for one provider.
 */
export const AI_CONFIDENCE_THRESHOLD = 70;

/* -------------------------------------------------------------------------- */
/* One-time passwords                                                         */
/* -------------------------------------------------------------------------- */

export type OtpChannel = 'phone' | 'email';

export type OtpRequest = {
  channel: OtpChannel;
  /** Normalised destination: digits for a phone, lowercased for an email. */
  destination: string;
  /** How the code was delivered, when the provider says. */
  deliveredVia: string;
  expiresAt: number;
  /** Seconds the client must wait before another send is accepted. */
  resendAfterSeconds: number;
  /**
   * Development only. A real provider never returns the code to the client, and
   * this field is absent from the remote implementation. The UI is forbidden
   * from rendering it outside a development build — enforced by the type being
   * checked at the render site rather than by convention.
   */
  developmentCode?: string;
};

export type OtpVerifyResult =
  | { ok: true }
  | { ok: false; reason: 'expired' | 'mismatch' | 'too_many_attempts' | 'unknown' };

export interface OtpProvider {
  readonly name: string;
  readonly status: ProviderStatus;
  request(channel: OtpChannel, destination: string): Promise<OtpRequest>;
  verify(channel: OtpChannel, destination: string, code: string): Promise<OtpVerifyResult>;
}

/* -------------------------------------------------------------------------- */
/* Dealers                                                                    */
/* -------------------------------------------------------------------------- */

export type DealerSearchQuery = {
  /** Explicit origin for a temporary search area. Absent means the profile. */
  origin?: GeoPoint;
  radiusKm: number;
  /** Free text over name and tags. */
  query?: string;
  tags?: readonly string[];
};

export type DealerSummary = {
  id: string;
  /** The shop's name as the dealer system reports it. Always present. */
  name: string;
  /**
   * The name is the dealer system's own. The translated label lives in the
   * display table, keyed by `id`, because a provider must not own the app's
   * wording — and a dealer the app has never seen still gets to be listed under
   * the name the source reports.
   */
  distanceKm: number;
  verifiedAt: number | null;
  openingHours: string | null;
  /**
   * Whether the shop is open right now, as the dealer system sees it.
   *
   * Nullable because a source that reports hours as free text has not told us
   * this, and deriving "open now" from a string on the client is how a farmer is
   * told a shop is open when it is shut.
   */
  openNow?: boolean | null;
  isAcceptingRequests: boolean;
  /** True for the shop this farmer already trades with, when the source knows. */
  isYourDealer?: boolean;
  /** Projection freshness from the dealer system, surfaced rather than hidden. */
  syncState: 'fresh' | 'stale' | 'unreachable';
  syncedAt: number | null;
  tags: readonly string[];
};

export type DealerProduct = {
  id: string;
  name: string;
  brand: string | null;
  category: string | null;
  canonicalProductId: string | null;
  registrationNo: string | null;
  packSize: string | null;
  /**
   * NULL is "the dealer system did not tell us", which the UI must render as
   * unknown. Zero means confirmed none. The distinction is the PRD's, and it is
   * preserved all the way to the screen.
   */
  availableQty: number | null;
  inStock: boolean | null;
  unitPrice: number | null;
  currency: string;
  syncState: 'fresh' | 'stale' | 'unreachable';
};

/**
 * A shop that stocks a canonical product, and what it is asking for it.
 *
 * This is the last link in the PRD's chain — crop problem → approved treatment →
 * canonical product → *live listing* → farmer result — and it is read from the
 * dealer system rather than written next to the treatment. Keeping the two apart
 * is what stops the app recommending a product *because* a shop has it, and what
 * stops the same shop being quoted at two prices on two screens.
 */
export type DealerStockist = {
  dealerId: string;
  /** The shop's name as the dealer system reports it. */
  name: string;
  distanceKm: number;
  /** Null means the shop did not quote a price; it is never turned into one. */
  unitPrice: number | null;
  currency: string;
  packSize: string | null;
  /** Null is "not reported", which is the third state, distinct from none. */
  inStock: boolean | null;
  syncState: 'fresh' | 'stale' | 'unreachable';
  /** When the dealer system last confirmed this listing. */
  observedAt: number | null;
};

export type StockistQuery = {
  /**
   * The canonical product's stable slug — the same identifier the scan result
   * cites — so the knowledge layer and the inventory layer meet on a value
   * neither of them owns.
   */
  canonicalProductId: string;
  radiusKm: number;
  /** Explicit origin, when the app already knows the farmer's area. */
  origin?: GeoPoint;
};

export interface DealerProvider {
  readonly name: string;
  /** Hard ceiling, applied by the provider as well as by the UI. */
  readonly maxRadiusKm: 100;
  search(query: DealerSearchQuery): Promise<Sourced<DealerSummary[]>>;
  products(dealerId: string): Promise<Sourced<DealerProduct[]>>;
  /** Where one canonical product can be bought right now, nearest first. */
  stockists(query: StockistQuery): Promise<Sourced<DealerStockist[]>>;
}

/* -------------------------------------------------------------------------- */
/* Analytics                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Deliberately tiny. An analytics interface with fifty methods is one nobody
 * implements honestly; this is the subset the PRD actually needs.
 */
export interface AnalyticsProvider {
  readonly name: string;
  capture(event: string, properties?: Record<string, unknown>): void;
  identify(partyId: string): void;
  reset(): void;
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The repository boundary.
 *
 * The brief is explicit that persistence must not be "random component-level
 * localStorage logic", and that moving to Supabase later must not require
 * rewriting the UI or the domain logic. So every store talks to this interface,
 * and there are two implementations behind it: a local one that is complete
 * today, and a Supabase-backed one that becomes the default when a project URL
 * and key are present.
 *
 * Reads are async even in the local implementation, on purpose. A synchronous
 * local repository would let a screen accidentally depend on data being
 * immediately available, and that dependency would only surface as a bug on the
 * day the real backend was connected.
 */
export type Collection =
  | 'session'
  | 'credit'
  | 'visits'
  | 'insights'
  | 'community'
  | 'chat'
  | 'crops'
  | 'media';

export interface Repository {
  readonly name: string;
  /** Reads the whole document for a collection owned by one farmer. */
  read<T>(collection: Collection, ownerId: string): Promise<T | null>;
  write<T>(collection: Collection, ownerId: string, value: T): Promise<void>;
  remove(collection: Collection, ownerId: string): Promise<void>;
  /** True when this repository is backed by the real backend. */
  readonly isRemote: boolean;
}
