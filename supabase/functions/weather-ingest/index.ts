/**
 * Weather ingestion: Open-Meteo into `weather_readings`.
 *
 * Why this exists when the app can already call Open-Meteo directly:
 *
 *   · The PRD requires the UI and the AI to read the *same* normalised reading.
 *     Two independent calls to a vendor at two different moments are two
 *     different readings, and an assistant citing weather the screen is not
 *     showing is exactly the disagreement the rule forbids.
 *   · Readings are cached per rounded location cell, so a village shares one
 *     fetch instead of one per farmer.
 *
 * The scheduled form reads `weather_ingestion_targets()`, which is service-only
 * because it can reveal village-scale locations. It fetches only cells whose
 * last current reading is more than 75 minutes old, and it upserts on the unique
 * event key so a retry corrects a reading instead of duplicating it.
 *
 * Routes, after the function name:
 *
 *   POST /weather-ingest  { lat, lon, days? }       → one cell
 *   GET  /weather-ingest?lat=..&lon=..              → one cell, for a scheduler
 *   POST /weather-ingest  { targets: true, limit? } → due farmer cells
 *   GET  /weather-ingest?targets=true&limit=20      → due farmer cells
 *
 * Open-Meteo is keyless, but its free tier is non-commercial. Staging/evaluation
 * use is covered; commercial deployment needs the provider's paid plan or a
 * different licensed source. `intel_sources` records that distinction.
 *
 * Failure is *recorded*, not thrown away: a row with `fetch_error` set is how the
 * UI can say "cannot read weather" instead of showing a blank where a number
 * should be, and how `weather_is_usable()` knows to return false.
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

const VENDOR = 'https://api.open-meteo.com/v1/forecast';
const PROVIDER_CODE = 'open_meteo';
const CELL_DECIMALS = 3;
const MAX_BATCH = 20;

const CURRENT_FIELDS = [
  'temperature_2m',
  'relative_humidity_2m',
  'apparent_temperature',
  'wind_speed_10m',
  'wind_direction_10m',
  'precipitation',
  'weather_code',
].join(',');

const DAILY_FIELDS = [
  'temperature_2m_max',
  'temperature_2m_min',
  'precipitation_sum',
  'weather_code',
].join(',');

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

function compass(degrees: number | null): string | null {
  if (degrees === null || !Number.isFinite(degrees)) return null;
  return COMPASS[Math.round((((degrees % 360) + 360) % 360) / 22.5) % 16] ?? null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const CONDITIONS: Record<number, string> = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Depositing rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Dense drizzle',
  56: 'Light freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Light freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Light rain showers', 81: 'Rain showers', 82: 'Violent rain showers',
  85: 'Snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with heavy hail',
};

/** GMT with no offset: a reading parsed in the wrong zone is a stale reading. */
function parseStamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const withSeconds = /T\d{2}:\d{2}$/.test(value) ? `${value}:00` : value;
  const parsed = Date.parse(`${withSeconds}Z`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

type Reading = Record<string, unknown>;
type Target = { lat_cell: number; lon_cell: number; due: boolean; farmer_count: number };

async function fetchVendor(
  lat: number,
  lon: number,
  days: number,
): Promise<{ body: Record<string, unknown>; sourceUrl: string }> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    timezone: 'GMT',
    current: CURRENT_FIELDS,
    daily: DAILY_FIELDS,
    forecast_days: String(days),
  });
  const sourceUrl = `${VENDOR}?${params.toString()}`;
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Open-Meteo answered ${response.status}.`);
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object') throw new Error('Open-Meteo returned no forecast.');
  return { body: body as Record<string, unknown>, sourceUrl };
}

function currentRow(
  body: Record<string, unknown>,
  latCell: number,
  lonCell: number,
  sourceUrl: string,
): Reading {
  const current = (body.current ?? {}) as Record<string, unknown>;
  const code = num(current.weather_code);
  return {
    provider_code: PROVIDER_CODE,
    lat_cell: latCell,
    lon_cell: lonCell,
    observed_at: parseStamp(current.time) ?? new Date().toISOString(),
    fetched_at: new Date().toISOString(),
    temp_c: num(current.temperature_2m),
    feels_like_c: num(current.apparent_temperature),
    humidity_pct: num(current.relative_humidity_2m),
    precip_mm: num(current.precipitation),
    wind_kph: num(current.wind_speed_10m),
    wind_dir: compass(num(current.wind_direction_10m)),
    condition_text: code === null ? null : (CONDITIONS[code] ?? null),
    condition_code: code === null ? null : String(code),
    kind: 'current',
    raw: {
      ...(current as Record<string, unknown>),
      source_url: sourceUrl,
      data_kind: 'current_weather',
      units: { temp_c: 'degrees Celsius', precip_mm: 'millimetres', wind_kph: 'kilometres per hour' },
      retrieved_at: new Date().toISOString(),
    },
    fetch_error: null,
  };
}

function dailyRows(
  body: Record<string, unknown>,
  latCell: number,
  lonCell: number,
  sourceUrl: string,
): { rows: Reading[]; seen: number; rejected: number } {
  const daily = (body.daily ?? {}) as Record<string, unknown>;
  const times = Array.isArray(daily.time) ? daily.time : [];
  const maxes = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max : [];
  const mins = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min : [];
  const rain = Array.isArray(daily.precipitation_sum) ? daily.precipitation_sum : [];
  const codes = Array.isArray(daily.weather_code) ? daily.weather_code : [];

  const rows: Reading[] = [];
  let rejected = 0;
  for (let index = 0; index < times.length; index += 1) {
    const date = times[index];
    if (typeof date !== 'string') {
      rejected += 1;
      continue;
    }
    const code = num(codes[index]);
    const from = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(from)) {
      rejected += 1;
      continue;
    }
    rows.push({
      provider_code: PROVIDER_CODE,
      lat_cell: latCell,
      lon_cell: lonCell,
      observed_at: new Date(from).toISOString(),
      fetched_at: new Date().toISOString(),
      temp_c: num(maxes[index]),
      feels_like_c: num(mins[index]),
      humidity_pct: null,
      precip_mm: num(rain[index]),
      wind_kph: null,
      wind_dir: null,
      condition_text: code === null ? null : (CONDITIONS[code] ?? null),
      condition_code: code === null ? null : String(code),
      kind: 'daily',
      valid_from: new Date(from).toISOString(),
      valid_to: new Date(from + 24 * 60 * 60 * 1000).toISOString(),
      raw: {
        temperature_2m_max: maxes[index] ?? null,
        temperature_2m_min: mins[index] ?? null,
        source_url: sourceUrl,
        data_kind: 'daily_forecast',
        units: { temp_c: 'degrees Celsius', precip_mm: 'millimetres' },
        retrieved_at: new Date().toISOString(),
      },
      fetch_error: null,
    });
  }
  return { rows, seen: times.length, rejected };
}

async function recordReadings(
  client: ReturnType<typeof adminClient>,
  rows: Reading[],
): Promise<unknown> {
  const { data, error } = await client.rpc('record_weather_readings', { p_rows: rows });
  if (error) throw new Error(error.message);
  return data;
}

async function recordFailure(
  client: ReturnType<typeof adminClient>,
  latCell: number,
  lonCell: number,
  detail: string,
): Promise<void> {
  // A failure row shares the same event key as the reading it could not produce.
  // It is upserted too, so a retry in the same second updates the reason rather
  // than stacking duplicate errors.
  await client.from('weather_readings').upsert({
    provider_code: PROVIDER_CODE,
    lat_cell: latCell,
    lon_cell: lonCell,
    observed_at: new Date().toISOString(),
    kind: 'current',
    fetch_error: detail,
    raw: {},
  }, { onConflict: 'provider_code,lat_cell,lon_cell,kind,observed_at' });
}

Deno.serve(async (req) => {
  const options = preflight(req);
  if (options) return options;
  const auth = requireIngestAuth(req);
  if (auth) return auth;

  try {
    const url = new URL(req.url);
    const body = req.method === 'POST' ? ((await readJson<Record<string, unknown>>(req)) ?? {}) : {};
    const days = Math.max(1, Math.min(Number(body.days ?? url.searchParams.get('days') ?? 7) || 7, 16));
    const wantsTargets =
      body.targets === true ||
      body.targets === 'true' ||
      url.searchParams.get('targets') === 'true';
    const limit = Math.max(
      1,
      Math.min(Number(body.limit ?? url.searchParams.get('limit') ?? MAX_BATCH) || MAX_BATCH, MAX_BATCH),
    );

    const client = adminClient();
    const rpc: IngestionRpc = (name, args) => client.rpc(name, args);
    const { error: recoveryError } = await client.rpc('recover_abandoned_ingestion_runs', {
      p_limit: 10,
    });
    if (recoveryError) {
      console.error(`[weather-ingest] abandoned-run recovery failed: ${recoveryError.message}`);
    }
    const startedAt = new Date().toISOString();

    if (wantsTargets) {
      const { data, error } = await client.rpc('weather_ingestion_targets', { p_limit: limit });
      if (error) return fail(error.message, 502);
      const due = ((data ?? []) as Target[]).filter((target) => target.due);
      if (due.length === 0) {
        return json({ ok: true, provider: PROVIDER_CODE, cellsRequested: 0, cellsWritten: 0, failed: 0 });
      }

      const { data: runRow, error: runError } = await client
        .from('weather_ingestion_runs')
        .insert({
          provider_code: PROVIDER_CODE,
          started_at: startedAt,
          status: 'running',
          cells_requested: due.length,
        })
        .select('id')
        .single();
      const runId = Number((runRow as { id?: number } | null)?.id);
      if (runError || !Number.isInteger(runId)) {
        return json({
          ok: false,
          error: 'Could not create the weather ingestion run.',
          detail: runError?.message ?? 'run id was not returned',
        }, 502);
      }

      const account = emptyAccount();
      let written = 0;
      let failed = 0;
      const errors: string[] = [];

      const heartbeat = async () => {
        const { data, error } = await client.rpc('touch_ingestion_run', {
          p_kind: 'weather',
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
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'run lease renewal failed';
        addIngestionError(errors, detail);
        const finished = await finishIngestionRun(
          'weather-ingest', runId, 'weather', 'failed', account, errors, written, rpc,
        );
        if (!finished.ok) {
          return json(ingestionFailurePayload(runId, account, errors, finished), 500);
        }
        return fail(detail, 500);
      }

      for (const target of due) {
        const lat = Number(target.lat_cell);
        const lon = Number(target.lon_cell);
        const latCell = Number(lat.toFixed(CELL_DECIMALS));
        const lonCell = Number(lon.toFixed(CELL_DECIMALS));
        try {
          const { body, sourceUrl } = await fetchVendor(lat, lon, days);
          const daily = dailyRows(body, latCell, lonCell, sourceUrl);
          const rows = [currentRow(body, latCell, lonCell, sourceUrl), ...daily.rows];
          account.fetched += 1 + daily.seen;
          account.rejected += daily.rejected;
          try {
            addWriteOutcome(account, await recordReadings(client, rows));
          } catch (error) {
            account.failed += rows.length;
            throw error;
          }
          written += 1;
        } catch (error) {
          const detail = error instanceof Error ? error.message : 'ingestion failed';
          addIngestionError(errors, detail);
          failed += 1;
          try {
            await recordFailure(client, latCell, lonCell, detail);
          } catch (markerError) {
            console.error(
              `[weather-ingest] failure marker could not be stored for ${latCell},${lonCell}: ${
                markerError instanceof Error ? markerError.message : 'unknown error'
              }`,
            );
          }
        }
      }

      const status = failed === 0
        ? completedStatus(account)
        : written > 0 ? 'partial' : 'failed';
      const finished = await finishIngestionRun(
        'weather-ingest', runId, 'weather', status, account, errors, written, rpc,
      );
      if (!finished.ok) {
        return json(ingestionFailurePayload(runId, account, errors, finished), 500);
      }

      return json({
        ok: status === 'ok',
        status,
        provider: PROVIDER_CODE,
        cellsRequested: due.length,
        cellsWritten: written,
        failed,
        accounting: account,
        firstError: errors[0] ?? null,
        processing_errors: errors,
      }, status === 'ok' ? 200 : status === 'partial' ? 207 : 502);
    }

    const latRaw = body.lat ?? url.searchParams.get('lat');
    const lonRaw = body.lon ?? url.searchParams.get('lon');
    const lat = typeof latRaw === 'number' ? latRaw : Number(clean(latRaw, 20));
    const lon = typeof lonRaw === 'number' ? lonRaw : Number(clean(lonRaw, 20));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return fail('lat and lon are required (or targets=true).');
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return fail('lat and lon are out of range.');

    const latCell = Number(lat.toFixed(CELL_DECIMALS));
    const lonCell = Number(lon.toFixed(CELL_DECIMALS));

    const { data: runRow, error: runError } = await client
      .from('weather_ingestion_runs')
      .insert({ provider_code: PROVIDER_CODE, started_at: startedAt, status: 'running', cells_requested: 1 })
      .select('id')
      .single();
    const runId = Number((runRow as { id?: number } | null)?.id);
    if (runError || !Number.isInteger(runId)) {
      return json({
        ok: false,
        error: 'Could not create the weather ingestion run.',
        detail: runError?.message ?? 'run id was not returned',
      }, 502);
    }

    const account = emptyAccount();
    const errors: string[] = [];

    const heartbeat = async () => {
      const { data, error } = await client.rpc('touch_ingestion_run', {
        p_kind: 'weather',
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
      const { body, sourceUrl } = await fetchVendor(lat, lon, days);
      const daily = dailyRows(body, latCell, lonCell, sourceUrl);
      const rows = [currentRow(body, latCell, lonCell, sourceUrl), ...daily.rows];
      account.fetched = 1 + daily.seen;
      account.rejected = daily.rejected;
      try {
        addWriteOutcome(account, await recordReadings(client, rows));
      } catch (error) {
        account.failed += rows.length;
        throw error;
      }

      const status = completedStatus(account);
      const finished = await finishIngestionRun(
        'weather-ingest', runId, 'weather', status, account, errors, 1, rpc,
      );
      if (!finished.ok) {
        return json(ingestionFailurePayload(runId, account, errors, finished), 500);
      }

      return json({
        ok: status === 'ok',
        status,
        provider: PROVIDER_CODE,
        cell: { lat: latCell, lon: lonCell },
        readingsFetched: account.fetched,
        readingsWritten: rowsWritten(account),
        accounting: account,
        processing_errors: errors,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'ingestion failed';
      try {
        await recordFailure(client, latCell, lonCell, detail);
      } catch (markerError) {
        console.error(
          `[weather-ingest] failure marker could not be stored for ${latCell},${lonCell}: ${
            markerError instanceof Error ? markerError.message : 'unknown error'
          }`,
        );
      }

      addIngestionError(errors, detail);
      const finished = await finishIngestionRun(
        'weather-ingest', runId, 'weather', 'failed', account, errors, 0, rpc,
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
