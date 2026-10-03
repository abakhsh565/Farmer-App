import { describe, expect, it, vi } from 'vitest';
import { createServices } from './registry';
import type { ServiceConfig } from './config';
import {
  DevelopmentWeatherProvider,
} from './providers/develop';
import { OpenMeteoWeatherProvider } from './providers/openMeteo';
import { isWeatherUsable, type GeoPoint } from './types';

/**
 * The live weather provider, tested where it can be.
 *
 * The payload below was captured from the real API for the profile location, so
 * the mapping is checked against the vendor's actual shape rather than against a
 * shape invented here — including the awkward parts: an offset-less timestamp,
 * an integer where the other fields are floats, and fields the screen has no
 * row for.
 *
 * The failure tests matter more than the happy one. A weather service that is
 * down must reach the screen as a state the farmer can read ("advice is paused,
 * here is why"), not as an unhandled rejection, and the reading that failed must
 * not come back as zeros dressed up as a measurement.
 */

const PROFILE: GeoPoint = { lat: 32.443, lon: 74.115 };

/** Captured from api.open-meteo.com on 2026-10-03T12:15Z for Wazirabad. */
const LIVE_PAYLOAD = {
  latitude: 32.442883,
  longitude: 74.14338,
  timezone: 'GMT',
  current_units: { time: 'iso8601', temperature_2m: '°C', wind_speed_10m: 'km/h' },
  current: {
    time: '2026-10-03T12:15',
    interval: 900,
    temperature_2m: 30.9,
    relative_humidity_2m: 66,
    apparent_temperature: 36.5,
    is_day: 1,
    wind_direction_10m: 228,
    wind_speed_10m: 2.4,
    precipitation: 0,
    weather_code: 0,
  },
  daily: {
    time: ['2026-10-03', '2026-10-04', '2026-10-05'],
    temperature_2m_max: [33.6, 33.8, 33.8],
    temperature_2m_min: [23.1, 22.6, 22.8],
    precipitation_sum: [0, 0, 0],
    weather_code: [0, 2, 61],
  },
};

/** The clock the captured payload is fresh against. */
const AT_1200Z = Date.parse('2026-10-03T12:20:00Z');

function providerReturning(body: unknown, ok = true, status = 200) {
  const fetchImpl = vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
  return { fetchImpl, provider: new OpenMeteoWeatherProvider(fetchImpl, undefined, () => AT_1200Z) };
}

describe('Open-Meteo provider', () => {
  it('maps the vendor’s own payload, with nulls only where the source is silent', async () => {
    const { provider } = providerReturning(LIVE_PAYLOAD);
    const reading = await provider.current(PROFILE);

    expect(reading.status).toBe('live');
    expect(reading.sourceLabel).toBe('Open-Meteo');
    expect(reading.data).toMatchObject({
      tempC: 30.9,
      feelsLikeC: 36.5,
      humidityPct: 66,
      precipMm: 0,
      windKph: 2.4,
      // 228° is south-west, and a farmer reads a direction, not a bearing.
      windDir: 'SW',
      conditionText: 'Clear sky',
      conditionKey: 'weather.condition.clear',
    });

    // The reading is fifteen minutes old at this clock, so advice may use it.
    expect(reading.observedAt).toBe(Date.parse('2026-10-03T12:15:00Z'));
    expect(reading.freshness).toBe('fresh');
    expect(isWeatherUsable(reading)).toBe(true);
  });

  it('asks for what it reads, in GMT, so a timestamp cannot shift by an offset', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return { ok: true, status: 200, json: async () => LIVE_PAYLOAD };
    }) as unknown as typeof fetch;

    const provider = new OpenMeteoWeatherProvider(fetchImpl, undefined, () => AT_1200Z);
    await provider.current(PROFILE);
    const url = new URL(seen[0] ?? '');

    expect(url.origin + url.pathname).toBe('https://api.open-meteo.com/v1/forecast');
    expect(url.searchParams.get('timezone')).toBe('GMT');
    expect(url.searchParams.get('latitude')).toBe('32.443');
    // Every field the mapper reads is a field the request asks for.
    for (const field of ['temperature_2m', 'wind_speed_10m', 'weather_code']) {
      expect(url.searchParams.get('current')).toContain(field);
    }
  });

  it('treats a reading older than the usable window as stale, so advice pauses', async () => {
    const stale = {
      current: { ...LIVE_PAYLOAD.current, time: '2026-10-03T06:00' },
    };
    const { provider } = providerReturning(stale);
    const reading = await provider.current(PROFILE);

    expect(reading.freshness).toBe('stale');
    expect(isWeatherUsable(reading)).toBe(false);
    // The numbers are still there: the farmer is shown the reason, not a blank.
    expect(reading.data.tempC).toBe(30.9);
  });

  it('reports a field the source did not send as null rather than as zero', async () => {
    const partial = { current: { time: '2026-10-03T12:15', temperature_2m: 28.2 } };
    const { provider } = providerReturning(partial);
    const reading = await provider.current(PROFILE);

    expect(reading.data.tempC).toBe(28.2);
    expect(reading.data.humidityPct).toBeNull();
    expect(reading.data.precipMm).toBeNull();
    expect(reading.data.windDir).toBeNull();
    // No code means no wording; the card falls back to the temperature alone.
    expect(reading.data.conditionText).toBeNull();
    expect(reading.data.conditionKey).toBeUndefined();
  });

  it('hands the screen a failure instead of throwing when the vendor is down', async () => {
    const { provider } = providerReturning(undefined, false, 503);
    const reading = await provider.current(PROFILE);

    expect(reading.status).toBe('failing');
    expect(reading.freshness).toBe('unavailable');
    expect(reading.error).toMatch(/503/);
    expect(reading.data.tempC).toBeNull();
    expect(isWeatherUsable(reading)).toBe(false);
  });

  it('reports a network that never answered as a failure too', async () => {
    const fetchImpl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch;
    const provider = new OpenMeteoWeatherProvider(fetchImpl, undefined, () => AT_1200Z);

    const reading = await provider.current(PROFILE);
    expect(reading.status).toBe('failing');
    expect(reading.error).toMatch(/ENOTFOUND/);
  });

  it('maps the daily forecast and clamps how far ahead it will ask', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return { ok: true, status: 200, json: async () => LIVE_PAYLOAD };
    }) as unknown as typeof fetch;
    const provider = new OpenMeteoWeatherProvider(fetchImpl, undefined, () => AT_1200Z);

    const forecast = await provider.forecast(PROFILE, 3);
    expect(forecast.data).toHaveLength(3);
    expect(forecast.data[0]).toMatchObject({
      date: '2026-10-03',
      maxC: 33.6,
      minC: 23.1,
      precipMm: 0,
      conditionText: 'Clear sky',
    });
    // 61 is "light rain" — the day the advice should be talking about rain.
    expect(forecast.data[2]?.conditionText).toBe('Light rain');

    await provider.forecast(PROFILE, 400);
    expect(new URL(seen[1] ?? '').searchParams.get('forecast_days')).toBe('16');
  });

  it('is chosen by configuration, not by accident', () => {
    const base: ServiceConfig = {
      supabase: { url: null, anonKey: null, configured: false },
      aiEndpoint: { url: null, configured: false },
      otpEndpoint: { url: null, configured: false },
      dealerEndpoint: { url: null, configured: false },
      analytics: { key: null, host: 'https://eu.i.posthog.com', configured: false },
      weather: { provider: 'open-meteo' },
    };

    expect(createServices(base).weather).toBeInstanceOf(OpenMeteoWeatherProvider);
    // An unconfigured build stays on the fixture: a test run, or a build with no
    // backend, must not start making network calls because of a default.
    expect(
      createServices({ ...base, weather: { provider: 'development' } }).weather,
    ).toBeInstanceOf(DevelopmentWeatherProvider);
  });
});

/**
 * The same provider, against the real service. Skipped unless asked for, so the
 * suite stays offline and deterministic while the live path is still provable —
 * `LIVE=1 npx vitest run src/services/openMeteo.test.ts`.
 */
describe.skipIf(process.env.LIVE !== '1')('Open-Meteo provider, live', () => {
  it('returns a usable reading for the profile location', async () => {
    const reading = await new OpenMeteoWeatherProvider().current(PROFILE);

    expect(reading.status).toBe('live');
    expect(reading.data.tempC).not.toBeNull();
    expect(reading.freshness).toBe('fresh');
    expect(isWeatherUsable(reading)).toBe(true);
    // eslint-disable-next-line no-console
    console.log(
      `live weather · ${reading.data.tempC}°C (feels ${reading.data.feelsLikeC}°C) · ` +
        `${reading.data.humidityPct}% humidity · ${reading.data.windKph} km/h ${reading.data.windDir} · ` +
        `${reading.data.conditionText} · observed ${new Date(reading.observedAt).toISOString()}`,
    );
  });
});
