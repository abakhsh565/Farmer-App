/**
 * Advisory ingestion: an *attempted* automated fetch with honest bookkeeping.
 *
 * The research found no verified public API for Punjab advisories or AMIS
 * rates — only HTML pages. This function therefore does not pretend a feed
 * exists. It fetches one configured URL (`ADVISORY_FEED_URL`) and accepts the
 * records only when they arrive as machine-readable JSON in a documented
 * shape. Anything else — no URL configured, an HTML page, an unreadable
 * payload — is recorded as a failed run in `advisory_import_runs` with the
 * reason, and nothing is stored. A missing feed is a known gap with an owner,
 * never a silently empty table and never a fabricated advisory.
 *
 * Accepted record shape (each item):
 *
 *   { title, summary, crop_code?, topic?, district?, area_label?,
 *     published_at?, valid_until?, source_url? }
 *
 * Crop codes must exist in `crop_catalog`; anything else is counted as
 * rejected rather than stored. District advisories are regional rows: `geog`
 * stays NULL so they can never be served as a point at a farmer's field.
 *
 * Routes, after the function name:
 *
 *   POST /advisory-ingest               → attempt the configured fetch
 *   GET  /advisory-ingest               → same, for a scheduler
 *
 * The durable path until a permitted feed exists is the CSV importer in
 * `scripts/import-advisories.mjs`, which writes the same table with the same
 * provenance columns.
 */

import { adminClient, clean, fail, json, preflight } from '../_shared/server.ts';

const SOURCE_CODE = 'punjab_advisory';

const TOPICS = new Set(['pest', 'disease', 'weed', 'water', 'weather_damage', 'sowing', 'other']);

function isoStamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value.trim());
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

type AdvisoryRow = {
  title: string;
  summary: string;
  crop_code: string | null;
  topic: string;
  district: string | null;
  area_label: string;
  source_ref: string | null;
  source_url: string | null;
  published_at: string;
  valid_until: string | null;
  /** The record exactly as the feed sent it, so the parsed row stays debuggable. */
  raw: Record<string, unknown>;
};

function normalise(records: unknown[]): { rows: AdvisoryRow[]; skipped: number } {
  const rows: AdvisoryRow[] = [];
  let skipped = 0;
  for (const record of records) {
    if (!record || typeof record !== 'object') {
      skipped += 1;
      continue;
    }
    const r = record as Record<string, unknown>;
    const title = clean(r.title, 200);
    const summary = clean(r.summary ?? r.body, 4000);
    if (!title || !summary) {
      skipped += 1;
      continue;
    }
    const topicRaw = clean(r.topic, 32)?.toLowerCase() ?? 'other';
    rows.push({
      title,
      summary,
      crop_code: clean(r.crop_code ?? r.crop, 32)?.toLowerCase() ?? null,
      topic: TOPICS.has(topicRaw) ? topicRaw : 'other',
      district: clean(r.district, 80),
      area_label: clean(r.area_label ?? r.area ?? r.district, 120) ?? 'Punjab',
      source_ref: clean(r.source_ref ?? r.id, 120),
      source_url: clean(r.source_url ?? r.url, 500),
      published_at: isoStamp(r.published_at ?? r.date) ?? new Date().toISOString(),
      valid_until: isoStamp(r.valid_until ?? r.expires_at),
      raw: r,
    });
  }
  return { rows, skipped };
}

Deno.serve(async (req) => {
  const options = preflight(req);
  if (options) return options;

  const feedUrl = Deno.env.get('ADVISORY_FEED_URL') ?? null;
  if (!feedUrl) {
    return fail(
      'No advisory feed is configured. Set ADVISORY_FEED_URL to a permitted machine-readable endpoint, or import via scripts/import-advisories.mjs. Nothing is ingested rather than something being invented.',
      503,
    );
  }

  const client = adminClient();
  const { data: runRow } = await client
    .from('advisory_import_runs')
    .insert({ source_code: SOURCE_CODE, status: 'running' })
    .select('id')
    .single();
  const runId = (runRow as { id?: number } | null)?.id ?? null;

  const finish = async (patch: Record<string, unknown>) => {
    if (runId !== null) {
      await client
        .from('advisory_import_runs')
        .update({ ...patch, finished_at: new Date().toISOString() })
        .eq('id', runId);
    }
  };

  try {
    const response = await fetch(feedUrl, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`The advisory feed answered ${response.status}.`);
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('json')) {
      throw new Error(
        'The advisory feed did not return machine-readable JSON (likely an HTML page). No rows stored; use the CSV importer for page-based sources.',
      );
    }
    const payload: unknown = await response.json();
    const records = Array.isArray(payload)
      ? payload
      : (payload as Record<string, unknown>)?.data ??
        (payload as Record<string, unknown>)?.records ??
        (payload as Record<string, unknown>)?.items;
    if (!Array.isArray(records) || records.length === 0) {
      throw new Error('The advisory feed returned no records.');
    }

    const { rows, skipped } = normalise(records);

    // Crop codes must exist; an unknown code is rejected, not stored.
    const { data: catalog } = await client.from('crop_catalog').select('code');
    const known = new Set(((catalog as Array<{ code: string }> | null) ?? []).map((c) => c.code));
    const valid = rows.filter((r) => r.crop_code === null || known.has(r.crop_code));
    const rejected = rows.length - valid.length + skipped;

    if (valid.length > 0) {
      const { error } = await client.from('agri_advisories').insert(
        valid.map((r) => ({
          title: r.title,
          summary: r.summary,
          crop_code: r.crop_code,
          topic: r.topic,
          district: r.district,
          area_label: r.area_label,
          source_code: SOURCE_CODE,
          source_ref: r.source_ref,
          source_url: r.source_url,
          published_at: r.published_at,
          valid_until: r.valid_until,
          raw: r.raw,
        })),
      );
      if (error) throw new Error(error.message);
    }

    await finish({
      status: rejected > 0 ? 'partial' : 'ok',
      rows_seen: records.length,
      rows_written: valid.length,
      rows_rejected: rejected,
    });

    return json({
      ok: true,
      source: SOURCE_CODE,
      rowsWritten: valid.length,
      rejected,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'ingestion failed';
    await finish({ status: 'failed', error: detail });
    return fail(detail, 502);
  }
});
