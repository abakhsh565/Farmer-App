/**
 * Forecast ingestion: district forecasts into `climate_forecasts`.
 *
 * The default is Open-Meteo ECMWF IFS because it is keyless, and because the
 * registered Layyah bias model was trained on exactly that provider/model pair.
 * A WeatherAPI path remains available when `provider=weatherapi` and the server
 * secret is configured; it is not silently selected, because a model trained on
 * ECMWF must not be applied to a different vendor's raw value.
 *
 * The key is a *server* secret. `WEATHERAPI_KEY` is read from this function's
 * environment and never leaves it.
 *
 * Honesty rules, enforced here rather than in the UI:
 *
 *   · A day the vendor did not report is not stored at all — not stored as zero.
 *     Zero rain is a fact; a missing day is not.
 *   · `issued_on` is part of the table's unique key, so today's pull and
 *     tomorrow's pull are different rows. A revised forecast is new information,
 *     not a correction of history.
 *   · A row whose forecast day is already past is refused by the table's own
 *     constraint; this function filters those out and counts them.
 *   · Failure is *recorded* in `climate_ingestion_runs` — including a missing
 *     WeatherAPI key — so an empty forecast table always has a reason attached.
 *
 * Routes, after the function name:
 *
 *   POST /forecast-ingest  { district, days?, provider? } → pulls the horizon
 *   GET  /forecast-ingest?district=..&days=..&provider=..  → same, for a scheduler
 *
 * Open-Meteo's free tier is non-commercial. This adapter is usable for staging
 * and evaluation; commercial deployment needs the provider's paid plan or a
 * different licensed forecast source. That licence state is recorded in
 * `intel_sources` and returned with every response.
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

const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
const WEATHERAPI = 'https://api.weatherapi.com/v1/forecast.json';
const OPEN_METEO_MODEL = 'ecmwf_ifs';

const OPEN_METEO_ATTRIBUTION =
  'Weather data by Open-Meteo.com (CC BY 4.0); ECMWF IFS model. Free tier is non-commercial.';
const WEATHERAPI_ATTRIBUTION = 'Weather data by WeatherAPI.com';

type Provider = 'open_meteo' | 'weatherapi';
type District = { code: string; hq_lat: number; hq_lon: number };
type ForecastRow = {
  provider_code: Provider;
  district_code: string;
  forecast_on: string;
  issued_on: string;
  tmax_c: number | null;
  tmin_c: number | null;
  precip_mm: number | null;
  humidity_pct: number | null;
  wind_kph: number | null;
  raw: Record<string, unknown>;
  source_url: string | null;
  provenance: Record<string, unknown>;
  run_id: number | null;
};

function measured(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function isoDay(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  return Number.isFinite(Date.parse(`${trimmed}T00:00:00Z`)) ? trimmed : null;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + count * 86400000).toISOString().slice(0, 10);
}

async function fetchOpenMeteo(
  lat: number,
  lon: number,
  days: number,
): Promise<{ payload: Record<string, unknown>; sourceUrl: string }> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    daily: [
      'temperature_2m_max',
      'temperature_2m_min',
      'precipitation_sum',
      'relative_humidity_2m_max',
      'wind_speed_10m_max',
    ].join(','),
    timezone: 'GMT',
    forecast_days: String(days),
    models: OPEN_METEO_MODEL,
  });
  const response = await fetch(`${OPEN_METEO}?${params.toString()}`);
  const payload = (await response.json().catch(() => null)) as
    | { error?: unknown; reason?: unknown; daily?: Record<string, unknown> }
    | null;
  if (!response.ok || payload?.error) {
    const reason = typeof payload?.reason === 'string' ? `: ${payload.reason}` : '.';
    throw new Error(`Open-Meteo answered ${response.status}${reason}`);
  }
  if (!payload?.daily || typeof payload.daily !== 'object') {
    throw new Error('Open-Meteo returned no daily forecast.');
  }
  return { payload: payload as Record<string, unknown>, sourceUrl: `${OPEN_METEO}?${params.toString()}` };
}

function openMeteoRows(
  payload: Record<string, unknown>,
  district: string,
  issuedOn: string,
): { rows: ForecastRow[]; seen: number; skipped: number; rejected: number } {
  const daily = (payload.daily ?? {}) as Record<string, unknown>;
  const times = Array.isArray(daily.time) ? daily.time : [];
  const maxes = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max : [];
  const mins = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min : [];
  const rain = Array.isArray(daily.precipitation_sum) ? daily.precipitation_sum : [];
  const humidity = Array.isArray(daily.relative_humidity_2m_max) ? daily.relative_humidity_2m_max : [];
  const wind = Array.isArray(daily.wind_speed_10m_max) ? daily.wind_speed_10m_max : [];

  const rows: ForecastRow[] = [];
  let skipped = 0;
  let rejected = 0;
  for (let index = 0; index < times.length; index += 1) {
    const day = isoDay(times[index]);
    if (day === null) {
      rejected += 1;
      continue;
    }
    if (day < issuedOn) {
      skipped += 1;
      continue;
    }
    const tmax = measured(maxes[index]);
    const tmin = measured(mins[index]);
    const precip = measured(rain[index]);
    const rh = measured(humidity[index]);
    const speed = measured(wind[index]);
    if (tmax === null && tmin === null && precip === null && rh === null && speed === null) {
      skipped += 1;
      continue;
    }
    rows.push({
      provider_code: 'open_meteo',
      district_code: district,
      forecast_on: day,
      issued_on: issuedOn,
      tmax_c: tmax,
      tmin_c: tmin,
      precip_mm: precip,
      humidity_pct: rh,
      wind_kph: speed,
      raw: {
        forecast_provider: 'open_meteo',
        forecast_model: OPEN_METEO_MODEL,
        forecast_on: day,
        temperature_2m_max: maxes[index] ?? null,
        temperature_2m_min: mins[index] ?? null,
        precipitation_sum: rain[index] ?? null,
        relative_humidity_2m_max: humidity[index] ?? null,
        wind_speed_10m_max: wind[index] ?? null,
      },
      source_url: null,
      provenance: {},
      run_id: null,
    });
  }
  return { rows, seen: times.length, skipped, rejected };
}

type VendorDay = {
  date?: unknown;
  day?: {
    maxtemp_c?: unknown;
    mintemp_c?: unknown;
    totalprecip_mm?: unknown;
    avghumidity?: unknown;
    maxwind_kph?: unknown;
  };
};

async function fetchWeatherApi(
  lat: number,
  lon: number,
  days: number,
): Promise<{ payload: Record<string, unknown>; sourceUrl: string }> {
  const key = Deno.env.get('WEATHERAPI_KEY');
  if (!key) throw new Error('WEATHERAPI_KEY is not configured on this function.');
  const params = new URLSearchParams({
    key,
    q: `${lat},${lon}`,
    days: String(days),
    aqi: 'no',
    alerts: 'no',
  });
  const response = await fetch(`${WEATHERAPI}?${params.toString()}`);
  const payload = (await response.json().catch(() => null)) as
    | { error?: { message?: unknown }; forecast?: { forecastday?: unknown } }
    | null;
  if (!response.ok) {
    const vendorMessage = typeof payload?.error?.message === 'string' ? payload.error.message : null;
    throw new Error(
      `WeatherAPI answered ${response.status}${vendorMessage ? `: ${vendorMessage}` : '.'}`,
    );
  }
  if (!Array.isArray(payload?.forecast?.forecastday)) {
    throw new Error('WeatherAPI returned no forecastday array.');
  }
  return {
    payload: payload as Record<string, unknown>,
    sourceUrl: `${WEATHERAPI}?q=${lat},${lon}&days=${days}`,
  };
}

function weatherApiRows(
  payload: Record<string, unknown>,
  district: string,
  issuedOn: string,
): { rows: ForecastRow[]; seen: number; skipped: number; rejected: number } {
  const forecastDays = (payload.forecast as { forecastday?: unknown }).forecastday;
  if (!Array.isArray(forecastDays)) {
    throw new Error('WeatherAPI returned no forecastday array.');
  }
  const rows: ForecastRow[] = [];
  let skipped = 0;
  let rejected = 0;
  for (const entry of forecastDays as VendorDay[]) {
    const day = isoDay(entry?.date);
    if (day === null) {
      rejected += 1;
      continue;
    }
    if (day < issuedOn) {
      skipped += 1;
      continue;
    }
    const vendorDay = entry?.day ?? {};
    const tmax = measured(vendorDay.maxtemp_c);
    const tmin = measured(vendorDay.mintemp_c);
    const precip = measured(vendorDay.totalprecip_mm);
    const rh = measured(vendorDay.avghumidity);
    const wind = measured(vendorDay.maxwind_kph);
    if (tmax === null && tmin === null && precip === null && rh === null && wind === null) {
      skipped += 1;
      continue;
    }
    rows.push({
      provider_code: 'weatherapi',
      district_code: district,
      forecast_on: day,
      issued_on: issuedOn,
      tmax_c: tmax,
      tmin_c: tmin,
      precip_mm: precip,
      humidity_pct: rh,
      wind_kph: wind,
      raw: vendorDay as Record<string, unknown>,
      source_url: null,
      provenance: {},
      run_id: null,
    });
  }
  return { rows, seen: forecastDays.length, skipped, rejected };
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
    if (!district) return fail('district is required (a districts.code, e.g. layyah).');

    const requestedProvider = clean(
      body.provider ?? url.searchParams.get('provider'),
      20,
    )?.toLowerCase();
    const provider: Provider = requestedProvider === 'weatherapi' ? 'weatherapi' : 'open_meteo';
    if (requestedProvider && requestedProvider !== 'open_meteo' && requestedProvider !== 'weatherapi') {
      return fail("provider must be 'open_meteo' or 'weatherapi'.");
    }

    // WeatherAPI's free horizon is three days; ECMWF via Open-Meteo supports
    // seven. A larger request fails at the vendor, so it is capped here.
    const maxDays = provider === 'weatherapi' ? 3 : 7;
    const rawDays = body.days ?? url.searchParams.get('days');
    const parsedDays = rawDays === null || rawDays === undefined ? maxDays : Number(rawDays);
    if (!Number.isFinite(parsedDays) || parsedDays < 1 || parsedDays > maxDays) {
      return fail(`days must be between 1 and ${maxDays} for ${provider}.`);
    }
    const days = Math.floor(parsedDays);

    const client = adminClient();
    const rpc: IngestionRpc = (name, args) => client.rpc(name, args);
    const { error: recoveryError } = await client.rpc('recover_abandoned_ingestion_runs', {
      p_limit: 10,
    });
    if (recoveryError) {
      console.error(`[forecast-ingest] abandoned-run recovery failed: ${recoveryError.message}`);
    }
    const { data: districtRow, error: districtError } = await client
      .from('districts')
      .select('code,hq_lat,hq_lon')
      .eq('code', district)
      .eq('is_active', true)
      .single();
    if (districtError || !districtRow) return fail(`Unknown district '${district}'.`, 404);
    const target = districtRow as unknown as District;

    const issuedOn = today();
    const { data: runRow, error: runError } = await client
      .from('climate_ingestion_runs')
      .insert({
        provider_code: provider,
        district_code: target.code,
        range_start: issuedOn,
        range_end: addDays(issuedOn, days - 1),
        status: 'running',
      })
      .select('id')
      .single();
    const runId = Number((runRow as { id?: number } | null)?.id);
    if (runError || !Number.isInteger(runId)) {
      return json({
        ok: false,
        error: 'Could not create the forecast ingestion run.',
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
      const { payload, sourceUrl } =
        provider === 'weatherapi'
          ? await fetchWeatherApi(target.hq_lat, target.hq_lon, days)
          : await fetchOpenMeteo(target.hq_lat, target.hq_lon, days);
      const parsed =
        provider === 'weatherapi'
          ? weatherApiRows(payload, target.code, issuedOn)
          : openMeteoRows(payload, target.code, issuedOn);

      account.fetched = parsed.seen;
      account.skipped = parsed.skipped;
      account.rejected = parsed.rejected;

      if (parsed.rows.length === 0) {
        throw new Error(
          `${provider} returned no usable forecast day (${parsed.skipped} skipped). Nothing was stored.`,
        );
      }

      const retrievedAt = new Date().toISOString();
      const provenance = {
        provider: provider === 'open_meteo' ? 'Open-Meteo' : 'WeatherAPI.com',
        model: provider === 'open_meteo' ? 'ECMWF IFS' : 'WeatherAPI forecast',
        endpoint: sourceUrl,
        coordinates: { lat: target.hq_lat, lon: target.hq_lon },
        units: {
          tmax_c: 'degrees Celsius',
          tmin_c: 'degrees Celsius',
          precip_mm: 'millimetres',
          humidity_pct: 'percent',
          wind_kph: 'kilometres per hour',
        },
        data_kind: 'forecast',
        licence:
          provider === 'open_meteo'
            ? 'CC BY 4.0; Open-Meteo free tier is non-commercial'
            : 'WeatherAPI.com terms; commercial use requires a licence',
        retrieved_at: retrievedAt,
      };
      const rows = parsed.rows.map((row) => ({
        ...row,
        source_url: provider === 'open_meteo' ? sourceUrl : null,
        provenance,
        run_id: runId,
      }));

      try {
        const { data, error } = await client.rpc('record_climate_forecasts', { p_rows: rows });
        if (error) throw new Error(error.message);
        addWriteOutcome(account, data);
      } catch (error) {
        account.failed += rows.length;
        throw error;
      }

      const finished = await finishIngestionRun(
        'forecast-ingest',
        runId,
        'climate',
        completedStatus(account, parsed.skipped > 0 || parsed.rejected > 0),
        account,
        errors,
        null,
        rpc,
      );
      if (!finished.ok) {
        return json(ingestionFailurePayload(runId, account, errors, finished), 500);
      }

      return json({
        ok: true,
        provider,
        model: provider === 'open_meteo' ? OPEN_METEO_MODEL : null,
        district: target.code,
        days: parsed.rows.length,
        skipped: parsed.skipped,
        rejected: parsed.rejected,
        accounting: account,
        issued_on: issuedOn,
        attribution:
          provider === 'open_meteo' ? OPEN_METEO_ATTRIBUTION : WEATHERAPI_ATTRIBUTION,
        calibration:
          'The database trigger applies an active model for this provider/district; calibrated columns may be populated.',
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'ingestion failed';
      addIngestionError(errors, detail);
      const finished = await finishIngestionRun(
        'forecast-ingest', runId, 'climate', 'failed', account, errors, null, rpc,
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
