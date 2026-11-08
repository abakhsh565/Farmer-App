/**
 * Climate ingestion: NASA POWER district history into `climate_observations`.
 *
 * Why NASA POWER and not the weather vendor: the daily `weather_readings` are
 * current conditions per 110 m cell; the intelligence engine needs multi-week
 * district history (rain accumulation, heat stress) for suitability and risk
 * features. POWER is keyless, commercial-safe (CC BY 4.0, citation), and needs
 * no vendor secret — only the server key, which every hosted function has.
 *
 * Honesty rules, enforced here rather than in the UI:
 *
 *   · A day the vendor did not report stays NULL, never 0. Zero rain is a fact;
 *     a missing day is not.
 *   · `observed_on` is the vendor's date, and re-pulling a range upserts on the
 *     table's unique key rather than duplicating it, so a re-run is safe.
 *   · Failure is *recorded* in `climate_ingestion_runs`, not thrown away: a
 *     district with no rows and a failed run is known-broken, which is
 *     different from a district that was never attempted.
 *   · At most ~5 concurrent vendor requests (NASA's own guidance); this function
 *     makes exactly one per call.
 *
 * Routes, after the function name:
 *
 *   POST /climate-ingest  { district, start, end } → pulls the range
 *   GET  /climate-ingest?district=..&start=..&end=.. → same, for a scheduler
 *
 * Dates are `YYYY-MM-DD`. Ranges are capped at 62 days per call so one request
 * cannot become a full-catalog download.
 */

import { adminClient, clean, fail, json, preflight, readJson, requireIngestAuth } from '../_shared/server.ts';
import {
  addIngestionError,
  addWriteOutcome,
  completedStatus,
  emptyAccount,
  finishIngestionRun,
  ingestionFailurePayload,
  type IngestionRpc,
} from '../_shared/ingestion-accounting.ts';

const VENDOR = 'https://power.larc.nasa.gov/api/temporal/daily/point';
const PROVIDER_CODE = 'nasa_power';

/** POWER parameters pulled, mapped to our columns below. Max 20 per request. */
const PARAMETERS = ['T2M_MAX', 'T2M_MIN', 'PRECTOTCORR', 'RH2M', 'WS10M'].join(',');

const MAX_RANGE_DAYS = 62;

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const parsed = Date.parse(`${trimmed}T00:00:00Z`);
  return Number.isFinite(parsed) ? trimmed : null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

/** POWER fills missing days with -999; that sentinel is "not reported", not a value. */
function measured(value: unknown): number | null {
  const n = num(value);
  if (n === null || n <= -999) return null;
  return n;
}

type District = { code: string; hq_lat: number; hq_lon: number };

function powerUrl(lat: number, lon: number, start: string, end: string): string {
  const compact = (d: string) => d.replace(/-/g, '');
  const params = new URLSearchParams({
    parameters: PARAMETERS,
    community: 'AG',
    longitude: String(lon),
    latitude: String(lat),
    start: compact(start),
    end: compact(end),
    format: 'JSON',
    'time-standard': 'UTC',
  });
  return `${VENDOR}?${params.toString()}`;
}

async function fetchPower(
  lat: number,
  lon: number,
  start: string,
  end: string,
): Promise<Record<string, Record<string, number>>> {
  const response = await fetch(powerUrl(lat, lon, start, end), {
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`NASA POWER answered ${response.status}.`);
  const body = (await response.json()) as {
    properties?: { parameter?: Record<string, Record<string, number>> };
  };
  const parameter = body?.properties?.parameter;
  if (!parameter || typeof parameter !== 'object') {
    throw new Error('NASA POWER returned no parameters.');
  }
  return parameter;
}

Deno.serve(async (req) => {
  const options = preflight(req);
  if (options) return options;
  const auth = requireIngestAuth(req);
  if (auth) return auth;

  try {
    const url = new URL(req.url);
    const body = req.method === 'POST' ? ((await readJson<Record<string, unknown>>(req)) ?? {}) : {};

    const district = clean(body.district ?? url.searchParams.get('district'), 40)?.toLowerCase();
    const start = isoDate(body.start ?? url.searchParams.get('start'));
    const end = isoDate(body.end ?? url.searchParams.get('end'));
    if (!district) return fail('district is required (a districts.code, e.g. layyah).');
    if (!start || !end) return fail('start and end are required as YYYY-MM-DD.');
    const spanDays = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000);
    if (!Number.isFinite(spanDays) || spanDays < 0 || spanDays > MAX_RANGE_DAYS) {
      return fail(`Range must be 0–${MAX_RANGE_DAYS} days.`);
    }

    const client = adminClient();
    const rpc: IngestionRpc = (name, args) => client.rpc(name, args);
    const { error: recoveryError } = await client.rpc('recover_abandoned_ingestion_runs', {
      p_limit: 10,
    });
    if (recoveryError) {
      console.error(`[climate-ingest] abandoned-run recovery failed: ${recoveryError.message}`);
    }

    const { data: districtRow, error: districtError } = await client
      .from('districts')
      .select('code,hq_lat,hq_lon')
      .eq('code', district)
      .eq('is_active', true)
      .single();
    if (districtError || !districtRow) return fail(`Unknown district '${district}'.`, 404);
    const target = districtRow as unknown as District;

    const { data: runRow, error: runError } = await client
      .from('climate_ingestion_runs')
      .insert({
        provider_code: PROVIDER_CODE,
        district_code: target.code,
        range_start: start,
        range_end: end,
        status: 'running',
      })
      .select('id')
      .single();
    const runId = Number((runRow as { id?: number } | null)?.id);
    if (runError || !Number.isInteger(runId)) {
      return json({
        ok: false,
        error: 'Could not create the climate ingestion run.',
        detail: runError?.message ?? 'run id was not returned',
      }, 502);
    }

    const account = emptyAccount();
    const errors: string[] = [];

    const heartbeat = async () => {
      const { data, error } = await client.rpc('touch_ingestion_run', {
        p_kind: 'climate',
        p_run_id: runId,
      });
      if (error || data === false) {
        throw new Error(
          `Run lease renewal failed: ${error?.message ?? 'run is no longer running'}`,
        );
      }
    };

    try {
      await heartbeat();
      const parameter = await fetchPower(target.hq_lat, target.hq_lon, start, end);
      const tmax = parameter['T2M_MAX'] ?? {};
      const tmin = parameter['T2M_MIN'] ?? {};
      const rain = parameter['PRECTOTCORR'] ?? {};
      const rh = parameter['RH2M'] ?? {};
      const wind = parameter['WS10M'] ?? {};
      const days = Object.keys(tmax).sort();

      if (days.length === 0) throw new Error('NASA POWER returned no days for this range.');
      account.fetched = days.length;

      const sourceUrl = powerUrl(target.hq_lat, target.hq_lon, start, end);
      const retrievedAt = new Date().toISOString();
      const rows = days.map((day) => ({
        provider_code: PROVIDER_CODE,
        district_code: target.code,
        observed_on: day.slice(0, 10),
        tmax_c: measured(tmax[day]),
        tmin_c: measured(tmin[day]),
        precip_mm: measured(rain[day]),
        humidity_pct: measured(rh[day]),
        // POWER reports 10 m wind in m/s; the column is kph.
        wind_kph: measured(wind[day]) === null ? null : Number((measured(wind[day]) as number * 3.6).toFixed(1)),
        raw: {
          T2M_MAX: measured(tmax[day]),
          T2M_MIN: measured(tmin[day]),
          PRECTOTCORR: measured(rain[day]),
          RH2M: measured(rh[day]),
          WS10M: measured(wind[day]),
        },
        source_url: sourceUrl,
        units: {
          tmax_c: '°C', tmin_c: '°C', precip_mm: 'mm', humidity_pct: '%', wind_kph: 'km/h',
        },
        provenance: {
          provider: 'NASA POWER',
          product: 'MERRA-2 daily reanalysis',
          grid_resolution: '0.5 degree',
          coordinates: { lat: target.hq_lat, lon: target.hq_lon },
          license: 'CC BY 4.0',
          retrieved_at: retrievedAt,
          note: 'gridded reanalysis, not a ground observation',
        },
        data_kind: 'reanalysis',
      }));

      try {
        const { data, error } = await client.rpc('record_climate_observations', { p_rows: rows });
        if (error) throw new Error(error.message);
        addWriteOutcome(account, data);
      } catch (error) {
        account.failed += rows.length;
        throw error;
      }

      const finished = await finishIngestionRun(
        'climate-ingest', runId, 'climate', completedStatus(account), account, errors, null, rpc,
      );
      if (!finished.ok) {
        return json(ingestionFailurePayload(runId, account, errors, finished), 500);
      }

      return json({
        ok: true,
        provider: PROVIDER_CODE,
        district: target.code,
        days: rows.length,
        accounting: account,
        range: { start, end },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'ingestion failed';
      addIngestionError(errors, detail);
      const finished = await finishIngestionRun(
        'climate-ingest', runId, 'climate', 'failed', account, errors, null, rpc,
      );
      if (!finished.ok) {
        return json(ingestionFailurePayload(runId, account, errors, finished), 500);
      }
      return fail(detail, 502);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unexpected error';
    return fail(detail, 500);
  }
});
