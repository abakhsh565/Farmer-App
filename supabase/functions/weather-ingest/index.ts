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
 * Open-Meteo is keyless, which is why this function needs no vendor secret —
 * only the server key, which every hosted function has.
 *
 * Routes, after the function name:
 *
 *   POST /weather-ingest  { lat, lon, days? }   → writes the cell's readings
 *   GET  /weather-ingest?lat=..&lon=..          → same, for a scheduler
 *
 * Failure is *recorded*, not thrown away: a row with `fetch_error` set is how the
 * UI can say "cannot read weather" instead of showing a blank where a number
 * should be, and how `weather_is_usable()` knows to return false.
 */

import { adminClient, clean, fail, json, preflight, readJson } from '../_shared/server.ts';

const VENDOR = 'https://api.open-meteo.com/v1/forecast';
const PROVIDER_CODE = 'open_meteo';

/**
 * Readings are stored per three-decimal cell (~110 m). Coarser than the farm,
 * finer than the district: two neighbouring farmers share a fetch, and a farmer
 * is never shown the weather of a town 30 km away.
 */
const CELL_DECIMALS = 3;

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

/** WMO code → the app's own vocabulary, kept beside the code in `raw`. */
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

async function fetchVendor(lat: number, lon: number, days: number): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    timezone: 'GMT',
    current: CURRENT_FIELDS,
    daily: DAILY_FIELDS,
    forecast_days: String(days),
  });
  const response = await fetch(`${VENDOR}?${params.toString()}`);
  if (!response.ok) throw new Error(`Open-Meteo answered ${response.status}.`);
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object') throw new Error('Open-Meteo returned no forecast.');
  return body as Record<string, unknown>;
}

function currentRow(body: Record<string, unknown>, latCell: number, lonCell: number): Reading {
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
    raw: current as Record<string, unknown>,
    fetch_error: null,
  };
}

function dailyRows(body: Record<string, unknown>, latCell: number, lonCell: number): Reading[] {
  const daily = (body.daily ?? {}) as Record<string, unknown>;
  const times = Array.isArray(daily.time) ? daily.time : [];
  const maxes = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max : [];
  const mins = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min : [];
  const rain = Array.isArray(daily.precipitation_sum) ? daily.precipitation_sum : [];
  const codes = Array.isArray(daily.weather_code) ? daily.weather_code : [];

  const rows: Reading[] = [];
  for (let index = 0; index < times.length; index += 1) {
    const date = times[index];
    if (typeof date !== 'string') continue;
    const code = num(codes[index]);
    const from = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(from)) continue;
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
      raw: { temperature_2m_max: maxes[index] ?? null, temperature_2m_min: mins[index] ?? null },
      fetch_error: null,
    });
  }
  return rows;
}

Deno.serve(async (req) => {
  const options = preflight(req);
  if (options) return options;

  try {
    const url = new URL(req.url);
    const body = req.method === 'POST' ? ((await readJson<Record<string, unknown>>(req)) ?? {}) : {};

    const latRaw = body.lat ?? url.searchParams.get('lat');
    const lonRaw = body.lon ?? url.searchParams.get('lon');
    const days = Math.max(1, Math.min(Number(body.days ?? url.searchParams.get('days') ?? 7) || 7, 16));

    const lat = typeof latRaw === 'number' ? latRaw : Number(clean(latRaw, 20));
    const lon = typeof lonRaw === 'number' ? lonRaw : Number(clean(lonRaw, 20));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return fail('lat and lon are required.');
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return fail('lat and lon are out of range.');

    const latCell = Number(lat.toFixed(CELL_DECIMALS));
    const lonCell = Number(lon.toFixed(CELL_DECIMALS));

    const client = adminClient();
    const startedAt = new Date().toISOString();
    const { data: runRow } = await client
      .from('weather_ingestion_runs')
      .insert({ provider_code: PROVIDER_CODE, started_at: startedAt, status: 'running', cells_requested: 1 })
      .select('id')
      .single();
    const runId = (runRow as { id?: number } | null)?.id ?? null;

    let written = 0;
    try {
      const payload = await fetchVendor(lat, lon, days);
      const rows = [currentRow(payload, latCell, lonCell), ...dailyRows(payload, latCell, lonCell)];

      const { error } = await client.from('weather_readings').insert(rows);
      if (error) throw new Error(error.message);
      written = rows.length;

      if (runId !== null) {
        await client
          .from('weather_ingestion_runs')
          .update({ status: 'ok', finished_at: new Date().toISOString(), cells_written: written })
          .eq('id', runId);
      }

      return json({
        ok: true,
        provider: PROVIDER_CODE,
        cell: { lat: latCell, lon: lonCell },
        readingsWritten: written,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'ingestion failed';

      // The failure is stored as a reading with `fetch_error`, so the app can
      // report "cannot read weather" for this cell instead of showing nothing.
      await client.from('weather_readings').insert({
        provider_code: PROVIDER_CODE,
        lat_cell: latCell,
        lon_cell: lonCell,
        observed_at: new Date().toISOString(),
        kind: 'current',
        fetch_error: detail,
        raw: {},
      });

      if (runId !== null) {
        await client
          .from('weather_ingestion_runs')
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
