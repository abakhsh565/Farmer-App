/**
 * The production marketplace.
 *
 * One API, read-only, anonymous: `search_marketplace` answers "what is listed near
 * this point", and the `marketplace_listings` view answers everything about one
 * listing or one branch. Branches are shops and listings are products, which is
 * the shape the Shop tab already speaks.
 *
 * Five rules from that contract are visible in this file rather than promised in a
 * comment:
 *
 *  · Every read happens on the call. Price and availability are never cached — not
 *    in a field, not in a memo — because the shop owner edits them and the farmer
 *    is standing in front of the shelf. Coordinates, which the API publishes as
 *    part of each row and the owner does not edit, are not cached either; they come
 *    with the rows.
 *
 *  · The listing row is the truth. `availableQty` is always NULL and never 0: the
 *    marketplace does not publish stock quantity, and a zero would be a claim. The
 *    same rule covers registration numbers, brands and phone numbers — omitted
 *    rather than invented.
 *
 *  · Nothing forbidden is requested. The only columns read are the ones the view
 *    publishes; cost price, margin, stock, supplier, owner and sales are not in the
 *    response, and this file does not name them.
 *
 *  · A refused key is a stop, not a retry. 401/403 comes back as a failed read with
 *    the reason in it, which the screens render as "could not be loaded" — never as
 *    "nothing nearby".
 *
 *  · An empty answer is an answer. `[]` is what a working marketplace returns when
 *    no branch has published a listing, and it must look different from a failure.
 */

import { serviceConfig } from '../config';
import type {
  DealerProduct,
  DealerProvider,
  DealerSearchQuery,
  DealerStockist,
  DealerSummary,
  GeoPoint,
  ProductHit,
  ProductSearchQuery,
  Sourced,
  StockistQuery,
} from '../types';

/** The categories the API accepts. Anything else is a validation error there. */
const MARKETPLACE_CATEGORIES = [
  'seed',
  'fertilizer',
  'pesticide',
  'herbicide',
  'equipment',
  'spray',
  'other',
] as const;

/** How many listings one page of the view returns. The API caps `p_limit` at 100. */
const PAGE_SIZE = 100;

/** A hard stop on pagination, so a bad cursor cannot loop forever. */
const MAX_PAGES = 5;

/** One row of `marketplace_listings`, as the API publishes it. */
type MarketplaceListing = {
  listing_id: string;
  branch_id: string;
  branch_name: string;
  branch_address: string | null;
  branch_latitude: number | null;
  branch_longitude: number | null;
  branch_location_label: string | null;
  product_id: string;
  product_name: string;
  category: string | null;
  image_url: string | null;
  variant_id: string | null;
  variant_label: string | null;
  unit_size: number | null;
  qty_step: number | null;
  base_unit: string | null;
  selling_price: number | string | null;
  availability: string | null;
  listed_at: string | null;
  updated_at: string | null;
  /** Only the list call reports it; the view does not. */
  distance_km?: number | string | null;
};

type MarketplaceConfig = { url: string | null; key: string | null; configured: boolean };

type Read<T> = { data: T | null; error: string | null; status: number };

/**
 * A failed read that still has a shape the screen can render.
 *
 * Same convention as the other providers: `status: 'failing'` is a health report,
 * not an exception. Only a bug or a broken promise reaches the screen as an error.
 */
function failing<T>(fallback: T, sourceLabel: string, error: string): Sourced<T> {
  const at = Date.now();
  return {
    data: fallback,
    sourceLabel,
    observedAt: at,
    fetchedAt: at,
    freshness: 'unavailable',
    status: 'failing',
    error,
  };
}

/** The API's own explanation, when it sent one. */
function messageOf(payload: unknown): string | null {
  if (payload && typeof payload === 'object' && 'message' in payload) {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim().length > 0) return message;
  }
  return null;
}

function numberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function instantOrNull(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Distance between two points, for the one question the list call cannot answer.
 *
 * `distance_km` exists only on the search result. Opening a product asks "who else
 * has this", which reads the view by product, so the distance has to be measured
 * here — from the branch's published coordinates, which are facts, rather than
 * from a remembered number, which would be a cache.
 */
function distanceKm(from: GeoPoint, lat: number | null, lon: number | null): number | null {
  if (lat === null || lon === null) return null;
  const radius = 6371;
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(lat - from.lat);
  const dLon = toRad(lon - from.lon);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.lat)) * Math.cos(toRad(lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The one listing → product mapping, shared by every read that returns a listing. */
function toDealerProduct(row: MarketplaceListing): DealerProduct {
  const size =
    row.variant_label ??
    (row.unit_size !== null && row.base_unit !== null
      ? `${row.unit_size} ${row.base_unit}`
      : null);

  return {
    id: row.listing_id,
    name: row.product_name,
    /* Not published by the marketplace. Absent is honest; a guessed brand is not. */
    brand: null,
    category: row.category,
    /* The stable id, so a product page and a stockist read meet on one value. */
    canonicalProductId: row.product_id,
    registrationNo: null,
    packSize: size,
    /* Only "available" is ever listed, and quantity is never published. */
    availableQty: null,
    inStock: row.availability === 'available' ? true : null,
    unitPrice: numberOrNull(row.selling_price),
    currency: 'PKR',
    syncState: 'fresh',
  };
}

export class MarketplaceDealerProvider implements DealerProvider {
  readonly name = 'Live marketplace';
  readonly maxRadiusKm = 150 as const;

  constructor(private readonly source: MarketplaceConfig = serviceConfig.marketplace) {}

  /* ── transport ─────────────────────────────────────────────────────────── */

  private headers(json: boolean): Record<string, string> | null {
    const key = this.source.key;
    if (!this.source.url || !key) return null;
    return {
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  private async request<T>(path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<Read<T>> {
    const headers = this.headers(init.body !== undefined);
    if (!headers) return { data: null, error: 'The marketplace is not configured.', status: 0 };

    try {
      const response = await fetch(`${this.source.url}/rest/v1/${path}`, {
        method: init.method,
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });

      const text = await response.text();
      let payload: unknown = null;
      try {
        payload = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }

      if (response.status === 401 || response.status === 403) {
        /*
         * The app's sentence first, the server's detail after it: a farmer cannot
         * act on "permission denied for function", and the screen must say what
         * actually happened — the key was refused, and nothing was retried.
         */
        const detail = messageOf(payload);
        return {
          data: null,
          error: detail
            ? `The marketplace refused this key. ${detail}`
            : 'The marketplace refused this key. Nothing was retried.',
          status: response.status,
        };
      }

      if (!response.ok) {
        return {
          data: null,
          error: messageOf(payload) ?? `The marketplace answered ${response.status}.`,
          status: response.status,
        };
      }

      return { data: payload as T, error: null, status: response.status };
    } catch (failure) {
      return {
        data: null,
        error: failure instanceof Error ? failure.message : 'The marketplace could not be reached.',
        status: 0,
      };
    }
  }

  /**
   * The search itself. Every list and every product read goes through one call, so
   * there is exactly one definition of "listed near here" in this provider.
   */
  private async searchListings(args: {
    origin: GeoPoint;
    radiusKm: number;
    query?: string;
    category?: string | null;
    limit?: number;
    offset?: number;
  }): Promise<Read<MarketplaceListing[]>> {
    return this.request<MarketplaceListing[]>('rpc/search_marketplace', {
      method: 'POST',
      body: {
        p_latitude: args.origin.lat,
        p_longitude: args.origin.lon,
        p_radius_km: Math.max(1, Math.min(args.radiusKm, this.maxRadiusKm)),
        p_query: args.query && args.query.trim().length > 0 ? args.query.trim() : null,
        p_category: args.category ?? null,
        p_limit: Math.max(1, Math.min(args.limit ?? PAGE_SIZE, PAGE_SIZE)),
        p_offset: Math.max(0, args.offset ?? 0),
      },
    });
  }

  /** Every listing of one branch, paged, read fresh. */
  private async branchListings(branchId: string): Promise<Read<MarketplaceListing[]>> {
    const rows: MarketplaceListing[] = [];

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const offset = page * PAGE_SIZE;
      const result = await this.request<MarketplaceListing[]>(
        `marketplace_listings?branch_id=eq.${encodeURIComponent(branchId)}&select=*&order=product_name&limit=${PAGE_SIZE}&offset=${offset}`,
        { method: 'GET' },
      );
      if (result.error) return { data: null, error: result.error, status: result.status };

      const batch = result.data ?? [];
      rows.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }

    return { data: rows, error: null, status: 200 };
  }

  /** Every branch listing one product, paged, read fresh. */
  private async productListings(productId: string): Promise<Read<MarketplaceListing[]>> {
    const rows: MarketplaceListing[] = [];

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const offset = page * PAGE_SIZE;
      const result = await this.request<MarketplaceListing[]>(
        `marketplace_listings?product_id=eq.${encodeURIComponent(productId)}&select=*&order=selling_price&limit=${PAGE_SIZE}&offset=${offset}`,
        { method: 'GET' },
      );
      if (result.error) return { data: null, error: result.error, status: result.status };

      const batch = result.data ?? [];
      rows.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }

    return { data: rows, error: null, status: 200 };
  }

  /** The newest edit among the rows, which is what "updated" means here. */
  private observedAt(rows: readonly MarketplaceListing[]): number {
    const newest = rows.reduce(
      (latest, row) => Math.max(latest, instantOrNull(row.updated_at) ?? 0),
      0,
    );
    return newest || Date.now();
  }

  /* ── the three dealer reads ────────────────────────────────────────────── */

  /**
   * The shop list, nearest first.
   *
   * The API answers per *listing*, so a branch with four products is four rows.
   * They are folded back into one shop here, keeping the smallest distance the API
   * reported for it — that is the distance to the branch, not to a product — and
   * collecting the categories it carries as its tags. Order comes from the API and
   * is preserved: nearest first, exactly as promised.
   */
  async search(query: DealerSearchQuery): Promise<Sourced<DealerSummary[]>> {
    const origin = query.origin;
    if (!origin) {
      return failing<DealerSummary[]>(
        [],
        this.name,
        'The marketplace needs the farmer’s area to measure distance. Choose a place first.',
      );
    }

    /*
     * A tag is either one of the API's categories or a product word. "Cotton" is
     * not a category, so it travels as a query instead of being silently dropped —
     * a filter chip that filters nothing is worse than one that does not exist.
     */
    const tag = query.tags?.[0] ?? null;
    const category = tag && (MARKETPLACE_CATEGORIES as readonly string[]).includes(tag) ? tag : null;
    const text = query.query ?? (tag && category === null ? tag : undefined);

    const result = await this.searchListings({
      origin,
      radiusKm: query.radiusKm,
      query: text,
      category,
    });

    if (result.error) return failing<DealerSummary[]>([], this.name, result.error);

    const rows = result.data ?? [];
    const shops = new Map<string, { summary: DealerSummary; categories: Set<string> }>();

    rows.forEach((row) => {
      const distance = numberOrNull(row.distance_km) ?? 0;
      const existing = shops.get(row.branch_id);

      if (existing) {
        if (distance < existing.summary.distanceKm) {
          shops.set(row.branch_id, { ...existing, summary: { ...existing.summary, distanceKm: distance } });
        }
        if (row.category) existing.categories.add(row.category);
        return;
      }

      shops.set(row.branch_id, {
        summary: {
          id: row.branch_id,
          name: row.branch_name,
          distanceKm: distance,
          /* Verification is not published, so no shop wears the mark. */
          verifiedAt: null,
          openingHours: null,
          openNow: null,
          isAcceptingRequests: true,
          syncState: 'fresh',
          syncedAt: instantOrNull(row.updated_at),
          tags: [],
          about: null,
          address: row.branch_address ?? row.branch_location_label,
          phone: null,
        },
        categories: new Set(row.category ? [row.category] : []),
      });
    });

    return {
      data: [...shops.values()].map(({ summary, categories }) => ({
        ...summary,
        tags: [...categories],
      })),
      sourceLabel: this.name,
      observedAt: this.observedAt(rows),
      fetchedAt: Date.now(),
      freshness: 'fresh',
      status: 'live',
    };
  }

  /** One shop's listings, read by branch. */
  async products(dealerId: string): Promise<Sourced<DealerProduct[]>> {
    const result = await this.branchListings(dealerId);
    if (result.error) return failing<DealerProduct[]>([], this.name, result.error);

    const rows = result.data ?? [];
    return {
      data: rows.map(toDealerProduct),
      sourceLabel: this.name,
      observedAt: this.observedAt(rows),
      fetchedAt: Date.now(),
      freshness: 'fresh',
      status: 'live',
    };
  }

  /**
   * Products by name, across every branch in range.
   *
   * The same product at two branches stays two rows — each with its own price —
   * because the farmer is choosing between two places to travel to, and averaging
   * them would quote a price neither shop is asking.
   */
  async searchProducts(query: ProductSearchQuery): Promise<Sourced<ProductHit[]>> {
    const origin = query.origin;
    if (!origin) {
      return failing<ProductHit[]>(
        [],
        this.name,
        'The marketplace needs the farmer’s area to measure distance. Choose a place first.',
      );
    }

    const result = await this.searchListings({
      origin,
      radiusKm: query.radiusKm,
      query: query.query,
    });
    if (result.error) return failing<ProductHit[]>([], this.name, result.error);

    const rows = result.data ?? [];
    return {
      data: rows.map((row) => ({
        product: toDealerProduct(row),
        dealerId: row.branch_id,
        dealerName: row.branch_name,
        distanceKm: numberOrNull(row.distance_km) ?? 0,
      })),
      sourceLabel: this.name,
      observedAt: this.observedAt(rows),
      fetchedAt: Date.now(),
      freshness: 'fresh',
      status: 'live',
    };
  }

  /**
   * Where one product can be bought, nearest first.
   *
   * Read by product from the view, then measured against the farmer's area here:
   * the view does not carry `distance_km`, and the coordinates it does carry are
   * the branch's own, so the distance is computed rather than remembered.
   */
  async stockists(query: StockistQuery): Promise<Sourced<DealerStockist[]>> {
    const origin = query.origin;
    if (!origin) {
      return failing<DealerStockist[]>(
        [],
        this.name,
        'The marketplace needs the farmer’s area to measure distance. Choose a place first.',
      );
    }

    const result = await this.productListings(query.canonicalProductId);
    if (result.error) return failing<DealerStockist[]>([], this.name, result.error);

    const rows = result.data ?? [];
    const nearby = rows
      .map((row) => ({ row, km: distanceKm(origin, row.branch_latitude, row.branch_longitude) }))
      .filter(
        (entry): entry is { row: MarketplaceListing; km: number } =>
          entry.km !== null && entry.km <= query.radiusKm,
      )
      .sort((a, b) => a.km - b.km);

    return {
      data: nearby.map(({ row, km }) => ({
        dealerId: row.branch_id,
        name: row.branch_name,
        distanceKm: km,
        unitPrice: numberOrNull(row.selling_price),
        currency: 'PKR',
        packSize: row.variant_label,
        inStock: row.availability === 'available' ? true : null,
        syncState: 'fresh',
        observedAt: instantOrNull(row.updated_at),
      })),
      sourceLabel: this.name,
      observedAt: this.observedAt(rows),
      fetchedAt: Date.now(),
      freshness: 'fresh',
      status: 'live',
    };
  }
}
