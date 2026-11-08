/**
 * Historical forecast ingestion: archived ECMWF IFS runs into `climate_forecasts`.
 *
 * This is the archive counterpart to `forecast-ingest`. It uses Open-Meteo's
 * Single Runs API, one run date at a time, and marks rows `is_archived=true` so
 * a historical load is distinguishable from today's live issue. The unique key
 * is the same, so a retry upserts rather than duplicating.
 *
 * Routes:
 *   POST /historical-forecast-ingest { district, start, end, step_days? }
 *   GET  /historical-forecast-ingest?district=..&start=..&end=..
 *
 * A run date is `YYYY-MM-DD` and means the 00 UTC run. The archive is source
 * data, not a ground observation. A missing run is recorded as a failed run;
 * it is never filled from a neighbouring issue.
 */

import { adminClient, clean, fail, json, preflight, readJson, requireIngestAuth } from '../_shared/server.ts';
import {
  addIngestionError,
  addWriteOutcome,
  completedStatus,
  emptyAccount,
  finishIngestionRun,
  ingestionFailurePayload,
  rowsWritten,
  type IngestionRpc,
} from '../_shared/ingestion-accounting.ts';

const VENDOR = 'https://single-runs-api.open-meteo.com/v1/forecast';
const MODEL = 'ecmwf_ifs';
const MAX_RUNS = 31;

type District = { code: string; hq_lat: number; hq_lon: number };
const q = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const day = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

function dates(start: string, end: string, step: number): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += step * 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

async function fetchRun(lat: number, lon: number, run: string) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    daily: [
      'temperature_2m_max', 'temperature_2m_min', 'precipitation_sum',
      'relative_humidity_2m_max', 'wind_speed_10m_max',
    ].join(','),
    timezone: 'GMT',
    forecast_days: '7',
    models: MODEL,
    run: `${run}T00:00`,
  });
  const url = `${VENDOR}?${params.toString()}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const payload = (await response.json().catch(() => null)) as
    | { reason?: unknown; daily?: Record<string, unknown> }
    | null;
  if (!response.ok || !payload?.daily) {
    const reason = typeof payload?.reason === 'string' ? `: ${payload.reason}` : '.';
    throw new Error(`Open-Meteo archive answered ${response.status}${reason}`);
  }
  return { url, daily: payload.daily };
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
    const start = day(body.start ?? url.searchParams.get('start'));
    const end = day(body.end ?? url.searchParams.get('end'));
    const step = Math.max(1, Math.min(Number(body.step_days ?? url.searchParams.get('step_days') ?? 1) || 1, 7));
    if (!district) return fail('district is required.');
    if (!start || !end) return fail('start and end must be YYYY-MM-DD.');
    if (end < start) return fail('end must not be before start.');
    const runs = dates(start, end, step);
    if (runs.length === 0) return fail('the date range contains no run.');
    if (runs.length > MAX_RUNS) return fail(`at most ${MAX_RUNS} runs may be requested.`);

    const client = adminClient();
    const rpc: IngestionRpc = (name, args) => client.rpc(name, args);
    const { error: recoveryError } = await client.rpc('recover_abandoned_ingestion_runs', {
      p_limit: 10,
    });
    if (recoveryError) {
      console.error(
        `[historical-forecast-ingest] abandoned-run recovery failed: ${recoveryError.message}`,
      );
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
        provider_code: 'open_meteo',
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
        error: 'Could not create the historical forecast ingestion run.',
        detail: runError?.message ?? 'run id was not returned',
      }, 502);
    }

    const account = emptyAccount();
    let failed = 0;
    let sourceSkipped = 0;
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
      for (const issue of runs) {
        await heartbeat();
        try {
          const { url: sourceUrl, daily } = await fetchRun(target.hq_lat, target.hq_lon, issue);
        const times = Array.isArray(daily.time) ? daily.time : [];
        const tmax = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max : [];
        const tmin = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min : [];
        const rain = Array.isArray(daily.precipitation_sum) ? daily.precipitation_sum : [];
        const rh = Array.isArray(daily.relative_humidity_2m_max) ? daily.relative_humidity_2m_max : [];
        const wind = Array.isArray(daily.wind_speed_10m_max) ? daily.wind_speed_10m_max : [];
          account.fetched += times.length;
          const rows = [];
          for (let i = 0; i < times.length; i += 1) {
            const valid = day(times[i]);
            if (!valid) {
              account.rejected += 1;
              continue;
            }
            if (valid < issue) {
              account.skipped += 1;
              sourceSkipped += 1;
              continue;
            }
            rows.push({
            provider_code: 'open_meteo',
            district_code: target.code,
            forecast_on: valid,
            issued_on: issue,
            tmax_c: num(tmax[i]),
            tmin_c: num(tmin[i]),
            precip_mm: num(rain[i]),
            humidity_pct: num(rh[i]),
            wind_kph: num(wind[i]),
            raw: {
              forecast_provider: 'open_meteo',
              forecast_model: MODEL,
              run: `${issue}T00:00Z`,
              source_url: sourceUrl,
              retrieved_at: new Date().toISOString(),
            },
            source_url: sourceUrl,
            provenance: {
              provider: 'Open-Meteo',
              model: 'ECMWF IFS',
              run_utc: `${issue}T00:00Z`,
              coordinates: { lat: target.hq_lat, lon: target.hq_lon },
              license: 'CC BY 4.0; free tier non-commercial',
              retrieved_at: new Date().toISOString(),
              archive: true,
            },
            is_archived: true,
            run_id: runId,
            });
          }
          if (rows.length === 0) throw new Error('the run returned no forecast day.');
          try {
            const { data, error } = await client.rpc('record_climate_forecasts', { p_rows: rows });
            if (error) throw new Error(error.message);
            addWriteOutcome(account, data);
          } catch (error) {
            account.failed += rows.length;
            throw error;
          }
        } catch (error) {
          failed += 1;
          addIngestionError(errors, error instanceof Error ? error.message : 'run failed');
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'run lease renewal failed';
      addIngestionError(errors, detail);
      const finished = await finishIngestionRun(
        'historical-forecast-ingest', runId, 'climate', 'failed', account, errors, null, rpc,
      );
      if (!finished.ok) {
        return json(ingestionFailurePayload(runId, account, errors, finished), 500);
      }
      return fail(detail, 500);
    }

    const status = failed === 0
      ? completedStatus(account, sourceSkipped > 0)
      : failed < runs.length ? 'partial' : 'failed';
    const finished = await finishIngestionRun(
      'historical-forecast-ingest', runId, 'climate', status, account, errors, null, rpc,
    );
    if (!finished.ok) {
      return json(ingestionFailurePayload(runId, account, errors, finished), 500);
    }
    const firstError = errors[0] ?? null;

    return json({
      ok: status === 'ok',
      status,
      provider: 'open_meteo',
      model: MODEL,
      district: target.code,
      runs_requested: runs.length,
      runs_failed: failed,
      rows_written: rowsWritten(account),
      accounting: account,
      run_id: runId,
      first_error: firstError,
      processing_errors: errors,
      note: 'Archived forecast rows are source data, not observations.',
    }, status === 'ok' ? 200 : status === 'partial' ? 207 : 502);
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'unexpected error', 500);
  }
});
