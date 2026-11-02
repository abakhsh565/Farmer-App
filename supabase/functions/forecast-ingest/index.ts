/**
 * Forecast ingestion: WeatherAPI.com district forecasts into `climate_forecasts`.
 *
 * Why this vendor and not NASA POWER: POWER's temporal services are hourly,
 * daily, monthly and climatological — all near-real-time, 2-3 days behind, with
 * no forecast product documented. The history in `climate_observations` comes
 * from POWER for exactly that reason, and the forecast comes from the vendor the
 * PRD names as the initial MVP candidate.
 *
 * The key is a *server* secret. `WEATHERAPI_KEY` is read from this function's
 * environment and never leaves it: a key in the APK is a key published on the
 * internet, and the client only ever reads the rows this function writes.
 *
 * Honesty rules, enforced here rather than in the UI:
 *
 *   · A day the vendor did not report is not stored at all — not stored as zero.
 *     Zero rain is a fact; a missing day is not.
 *   · `issued_on` is part of the table's unique key, so today's pull and
 *     tomorrow's pull are different rows. A revised forecast is new information,
 *     not a correction of history.
 *   · A row whose forecast day is already past is refused by the table's own
 *     constraint; this function filters those out and counts them rather than
 *     letting one bad day roll back a district.
 *   · Failure is *recorded* in `climate_ingestion_runs` — including "no key
 *     configured" — so an empty forecast table always has a reason attached to
 *     it, and a missing key looks like the deployment mistake it is.
 *
 * Routes, after the function name:
 *
 *   POST /forecast-ingest  { district, days? } → pulls the horizon
 *   GET  /forecast-ingest?district=..&days=..  → same, for a scheduler
 *
 * `days` is capped at 3: that is the free plan's horizon, and a larger request
 * would fail at the vendor anyway. A paid plan can raise it by changing the cap
 * here, in one place.
 */

import { adminClient, clean, fail, json, preflight, readJson } from '../_shared/server.ts';

const VENDOR = 'https://api.weatherapi.com/v1/forecast.json';
const PROVIDER_CODE = 'weatherapi';

/** The free plan's horizon. Asking for more does not fail here, it fails there. */
const MAX_DAYS = 3;
const DEFAULT_DAYS = 3;

/** WeatherAPI's required wording. Returned with the payload so a caller can show it. */
const ATTRIBUTION = 'Weather data by WeatherAPI.com';

type District = { code: string; hq_lat: number; hq_lon: number };

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

/** A measured number, or null when the vendor did not report it. Never a stand-in for zero. */
function measured(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

/** The vendor's own date, as `YYYY-MM-DD`. Anything else is skipped, not guessed. */
function isoDay(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  return Number.isFinite(Date.parse(`${trimmed}T00:00:00Z`)) ? trimmed : null;
}

/** Today in UTC, which is the calendar the vendor's dates are compared against. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  const options = preflight(req);
  if (options) return options;

  try {
    const url = new URL(req.url);
    const body = req.method === 'POST' ? ((await readJson<Record<string, unknown>>(req)) ?? {}) : {};

    const district = clean(body.district ?? url.searchParams.get('district'), 40)?.toLowerCase();
    if (!district) return fail('district is required (a districts.code, e.g. layyah).');

    const rawDays = body.days ?? url.searchParams.get('days');
    const parsedDays = rawDays === null || rawDays === undefined ? DEFAULT_DAYS : Number(rawDays);
    if (!Number.isFinite(parsedDays) || parsedDays < 1 || parsedDays > MAX_DAYS) {
      return fail(`days must be between 1 and ${MAX_DAYS}.`);
    }
    const days = Math.floor(parsedDays);

    // The client is created before the key is checked so that a missing key is
    // recorded as a failed run rather than looking like a district that was never
    // attempted. The message says which secret to set, because that is the only
    // thing an operator can act on.
    const client = adminClient();
    const key = Deno.env.get('WEATHERAPI_KEY');

    const { data: districtRow, error: districtError } = await client
      .from('districts')
      .select('code,hq_lat,hq_lon')
      .eq('code', district)
      .eq('is_active', true)
      .single();
    if (districtError || !districtRow) return fail(`Unknown district '${district}'.`, 404);
    const target = districtRow as unknown as District;

    const { data: runRow } = await client
      .from('climate_ingestion_runs')
      .insert({
        provider_code: PROVIDER_CODE,
        district_code: target.code,
        // For a forecast, the "range" is the horizon being asked for: today
        // through the last day requested.
        range_start: today(),
        range_end: new Date(Date.now() + (days - 1) * 86400000).toISOString().slice(0, 10),
        status: 'running',
      })
      .select('id')
      .single();
    const runId = (runRow as { id?: number } | null)?.id ?? null;

    const recordFailure = async (detail: string) => {
      if (runId !== null) {
        await client
          .from('climate_ingestion_runs')
          .update({ status: 'failed', finished_at: new Date().toISOString(), error: detail })
          .eq('id', runId);
      }
    };

    if (!key) {
      const detail = 'WEATHERAPI_KEY is not configured on this function.';
      await recordFailure(detail);
      return fail(detail, 503);
    }

    try {
      const params = new URLSearchParams({
        key,
        q: `${target.hq_lat},${target.hq_lon}`,
        days: String(days),
        aqi: 'no',
        alerts: 'no',
      });
      const response = await fetch(`${VENDOR}?${params.toString()}`);
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: unknown }; forecast?: { forecastday?: unknown } }
        | null;

      if (!response.ok) {
        // The vendor's own sentence, kept rather than paraphrased: it is the only
        // part that distinguishes a bad key from a bad location from a quota.
        const vendorMessage =
          typeof payload?.error?.message === 'string' ? payload.error.message : null;
        throw new Error(
          `WeatherAPI answered ${response.status}${vendorMessage ? `: ${vendorMessage}` : '.'}`,
        );
      }

      const forecastDays = payload?.forecast?.forecastday;
      if (!Array.isArray(forecastDays)) {
        throw new Error('WeatherAPI returned no forecastday array.');
      }

      const issuedOn = today();
      let skipped = 0;
      const rows = [];

      for (const entry of forecastDays as VendorDay[]) {
        const day = isoDay(entry?.date);
        // A past date is not a forecast, and the table's constraint would reject
        // the whole batch for it. Counted, so the response can say so.
        if (day === null || day < issuedOn) {
          skipped += 1;
          continue;
        }
        const vendorDay = entry?.day ?? {};
        const tmax = measured(vendorDay.maxtemp_c);
        const tmin = measured(vendorDay.mintemp_c);
        const precip = measured(vendorDay.totalprecip_mm);
        const humidity = measured(vendorDay.avghumidity);
        const wind = measured(vendorDay.maxwind_kph);

        // A day with nothing measured is not a forecast of anything, so no row is
        // written for it. The day is simply absent, which is how the table
        // distinguishes "not reported" from "no rain".
        if (tmax === null && tmin === null && precip === null && humidity === null && wind === null) {
          skipped += 1;
          continue;
        }

        rows.push({
          provider_code: PROVIDER_CODE,
          district_code: target.code,
          forecast_on: day,
          issued_on: issuedOn,
          tmax_c: tmax,
          tmin_c: tmin,
          precip_mm: precip,
          humidity_pct: humidity,
          wind_kph: wind,
          raw: vendorDay as Record<string, unknown>,
        });
      }

      if (rows.length === 0) {
        throw new Error(
          `WeatherAPI returned no usable forecast day (${skipped} skipped). Nothing was stored.`,
        );
      }

      const { error } = await client.from('climate_forecasts').upsert(rows, {
        onConflict: 'provider_code,district_code,forecast_on,issued_on',
      });
      if (error) throw new Error(error.message);

      if (runId !== null) {
        await client
          .from('climate_ingestion_runs')
          .update({
            status: skipped > 0 ? 'partial' : 'ok',
            finished_at: new Date().toISOString(),
            rows_seen: forecastDays.length,
            rows_written: rows.length,
          })
          .eq('id', runId);
      }

      return json({
        ok: true,
        provider: PROVIDER_CODE,
        district: target.code,
        days: rows.length,
        skipped,
        issued_on: issuedOn,
        // The licence's condition, returned with the data it applies to.
        attribution: ATTRIBUTION,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'ingestion failed';
      await recordFailure(detail);
      return fail(detail, 502);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unexpected error';
    return fail(detail, 500);
  }
});
