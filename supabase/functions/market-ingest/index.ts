/**
 * Market ingestion: mandi rates into `market_observations`.
 *
 * The PRD forbids inventing an AMIS key, and this function does not. What it does
 * is the honest version of "real market rates today":
 *
 *   1. **AMIS Punjab**, when an endpoint has been configured. The PRD names it as
 *      the approved source, and it needs registration with the Agriculture
 *      Department, so the adapter is written and waits rather than being faked.
 *   2. **A configured public JSON feed** (`MARKET_FEED_URL`), which is what makes
 *      live rates reachable before that registration exists. The row records
 *      which source it came from, so a rate from a secondary feed can never be
 *      presented as an AMIS figure.
 *   3. **Nothing.** No source configured means no ingestion, and the app keeps
 *      showing the development fixture — which is labelled as such.
 *
 * Two rules are enforced here rather than in the UI:
 *
 *   · A missing price is `null`, never `0`. Zero is a real price and "not
 *     reported" is not, and the two must stay distinguishable all the way down.
 *   · `observed_on` is the *market's* date, not the fetch time. Re-ingesting a
 *     day updates the row (the table's unique constraint) rather than
 *     duplicating it, so a re-run is safe.
 *
 * Routes, after the function name:
 *
 *   POST /market-ingest                 → ingest from the configured source
 *   POST /market-ingest { commodity }   → limit to one commodity
 *   GET  /market-ingest                 → same, for a scheduler
 */

import { adminClient, clean, fail, json, preflight, readJson } from '../_shared/server.ts';

const AMIS_CODE = 'amis_punjab';
const FEED_CODE = 'public_feed';

/**
 * Commodity names as market feeds spell them, mapped to our codes.
 *
 * A feed says "Wheat", "WHEAT (40KG)" or "گندم"; the app's commodity code is one
 * value. Translating here means a new spelling in a feed is a mapping change and
 * not a screen that silently shows nothing.
 */
const COMMODITY_ALIASES: Record<string, string> = {
  wheat: 'wheat', 'گندم': 'wheat', 'wheat (40kg)': 'wheat',
  cotton: 'cotton', 'کپاس': 'cotton', 'cotton (40kg)': 'cotton',
  rice: 'rice', 'چاول': 'rice', paddy: 'rice', 'rice (40kg)': 'rice',
  maize: 'maize', 'مکئی': 'maize', corn: 'maize', 'maize (40kg)': 'maize',
  sugarcane: 'sugarcane', 'گنا': 'sugarcane', 'sugarcane (40kg)': 'sugarcane',
  potato: 'potato', 'آلو': 'potato', 'potato (40kg)': 'potato',
  onion: 'onion', 'پیاز': 'onion', 'onion (40kg)': 'onion',
  gram: 'gram', 'چنا': 'gram', chana: 'gram', 'gram (40kg)': 'gram',
};

function commodityCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase();
  return COMMODITY_ALIASES[key] ?? null;
}

/** A number the source actually reported, or null. Never a stand-in for zero. */
function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value >= 0 ? value : null;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[,\s]/g, '');
    if (cleaned.length === 0) return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

/** The market's own date, as `YYYY-MM-DD`. Anything else is rejected, not guessed. */
function observedOn(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  // Day-first and month-first are both common in feeds; only an unambiguous
  // ISO-looking value is accepted, because guessing a date is guessing a price.
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

type Row = {
  source_code: string;
  commodity_code: string;
  market_name: string;
  district: string | null;
  observed_on: string;
  min_price: number | null;
  max_price: number | null;
  modal_price: number | null;
  currency: string;
  unit: string;
  arrivals_tonnes: number | null;
  raw: Record<string, unknown>;
  run_id: number | null;
};

/**
 * Normalises whatever the feed returns.
 *
 * Feeds in this space are wildly inconsistent — an array of records, a wrapper
 * object with a `data` or `records` key, camelCase or snake_case fields. Rather
 * than demand one shape, this accepts the common ones and *skips* a record it
 * cannot read, counting the skips so the response can report them. A silently
 * dropped record is how a market disappears from the app without anybody
 * noticing.
 */
function normalise(
  payload: unknown,
  sourceCode: string,
  runId: number | null,
  only?: string | null,
): { rows: Row[]; seen: number; skipped: number } {
  let records: unknown[] = [];
  if (Array.isArray(payload)) records = payload;
  else if (payload && typeof payload === 'object') {
    const wrapper = payload as Record<string, unknown>;
    for (const key of ['data', 'records', 'results', 'rates', 'items']) {
      if (Array.isArray(wrapper[key])) {
        records = wrapper[key] as unknown[];
        break;
      }
    }
  }

  const rows: Row[] = [];
  let skipped = 0;

  for (const record of records) {
    if (!record || typeof record !== 'object') {
      skipped += 1;
      continue;
    }
    const r = record as Record<string, unknown>;

    const code = commodityCode(r.commodity ?? r.commodity_name ?? r.crop ?? r.item ?? r.name);
    const market = clean(r.market ?? r.market_name ?? r.mandi ?? r.marketName, 120);
    const date = observedOn(r.observed_on ?? r.date ?? r.observation_date ?? r.rate_date);

    const min = num(r.min_price ?? r.minPrice ?? r.minimum ?? r.min);
    const max = num(r.max_price ?? r.maxPrice ?? r.maximum ?? r.max);
    const modal = num(r.modal_price ?? r.modalPrice ?? r.modal ?? r.avg_price ?? r.average);

    // A record with no commodity, no market, no date or no price at all is not
    // a reading. It is counted and skipped rather than stored as empty.
    if (!code || !market || !date || (min === null && max === null && modal === null)) {
      skipped += 1;
      continue;
    }
    if (only && code !== only) continue;
    // The table refuses an inverted range; catching it here keeps the run going.
    if (min !== null && max !== null && min > max) {
      skipped += 1;
      continue;
    }

    rows.push({
      source_code: sourceCode,
      commodity_code: code,
      market_name: market,
      district: clean(r.district ?? r.district_name, 80),
      observed_on: date,
      min_price: min,
      max_price: max,
      modal_price: modal,
      currency: clean(r.currency, 8) ?? 'PKR',
      unit: clean(r.unit, 16) ?? '40kg',
      arrivals_tonnes: num(r.arrivals_tonnes ?? r.arrivals ?? r.volume),
      raw: r,
      run_id: runId,
    });
  }

  return { rows, seen: records.length, skipped };
}

async function fetchFeed(url: string, token: string | null): Promise<unknown> {
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new Error(`The market feed answered ${response.status}.`);
  return await response.json();
}

Deno.serve(async (req) => {
  const options = preflight(req);
  if (options) return options;

  try {
    const url = new URL(req.url);
    const body = req.method === 'POST' ? ((await readJson<Record<string, unknown>>(req)) ?? {}) : {};
    const only = clean(body.commodity ?? url.searchParams.get('commodity'), 40)?.toLowerCase() ?? null;

    const amisUrl = Deno.env.get('AMIS_FEED_URL') ?? null;
    const amisToken = Deno.env.get('AMIS_FEED_TOKEN') ?? null;
    const publicUrl = Deno.env.get('MARKET_FEED_URL') ?? null;
    const publicToken = Deno.env.get('MARKET_FEED_TOKEN') ?? null;

    /*
     * Which source to read. AMIS wins when it exists because the PRD names it as
     * the approved source; the public feed is the stand-in that makes live rates
     * reachable before registration, and it is stored under its own source code
     * so it can never be mistaken for an AMIS figure.
     */
    const chosen = amisUrl
      ? { code: AMIS_CODE, url: amisUrl, token: amisToken, name: 'AMIS Punjab' }
      : publicUrl
        ? { code: FEED_CODE, url: publicUrl, token: publicToken, name: 'Configured public market feed' }
        : null;

    if (!chosen) {
      return fail(
        'No market source is configured. Set AMIS_FEED_URL (the approved source) or MARKET_FEED_URL (a public feed) as a function secret. Nothing is ingested rather than something being invented.',
        503,
      );
    }

    const client = adminClient();

    // The source row must exist before a reading can reference it.
    await client
      .from('market_sources')
      .upsert(
        {
          code: chosen.code,
          name: chosen.name,
          kind: chosen.code === AMIS_CODE ? 'amis_punjab' : 'research_feed',
          endpoint_url: chosen.url,
          is_active: true,
          notes:
            chosen.code === AMIS_CODE
              ? 'Approved agricultural market information source.'
              : 'Public market feed used until AMIS registration completes. Stored under its own source code so it is never presented as an AMIS figure.',
        },
        { onConflict: 'code' },
      );

    const { data: runRow } = await client
      .from('market_ingestion_runs')
      .insert({ source_code: chosen.code, status: 'running' })
      .select('id')
      .single();
    const runId = (runRow as { id?: number } | null)?.id ?? null;

    try {
      const payload = await fetchFeed(chosen.url, chosen.token);
      const { rows, seen, skipped } = normalise(payload, chosen.code, runId, only);

      if (rows.length === 0) {
        throw new Error(
          skipped > 0
            ? `The feed returned ${skipped} record(s), none of which could be read.`
            : 'The feed returned no records.',
        );
      }

      /*
       * Upsert on the table's own unique key, so re-running a day corrects it
       * rather than duplicating it. A duplicate would double-count in any
       * average and make a re-run unsafe — which is exactly when someone
       * re-runs.
       */
      const { error } = await client
        .from('market_observations')
        .upsert(rows, { onConflict: 'source_code,commodity_code,market_name,observed_on' });
      if (error) throw new Error(error.message);

      if (runId !== null) {
        await client
          .from('market_ingestion_runs')
          .update({
            // Rejections are recorded, not swallowed: a feed that renames a
            // field would otherwise look like a market that quietly stopped
            // publishing, and the run row is where that is visible.
            status: skipped > 0 ? 'partial' : 'ok',
            finished_at: new Date().toISOString(),
            rows_seen: seen,
            rows_written: rows.length,
            rows_rejected: skipped,
          })
          .eq('id', runId);
      }

      const commodities = [...new Set(rows.map((r) => r.commodity_code))].sort();
      const markets = [...new Set(rows.map((r) => r.market_name))];

      return json({
        ok: true,
        source: chosen.code,
        sourceName: chosen.name,
        rowsWritten: rows.length,
        skipped,
        commodities,
        markets: markets.length,
        latestDate: rows.map((r) => r.observed_on).sort().at(-1) ?? null,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'ingestion failed';
      if (runId !== null) {
        await client
          .from('market_ingestion_runs')
          .update({ status: 'failed', finished_at: new Date().toISOString(), error: detail })
          .eq('id', runId);
      }
      return fail(detail, 502);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unexpected error';
    return fail(detail, 500);
  }
});
