/**
 * Live weather, from Open-Meteo.
 *
 * This is the first provider in the app that talks to a real vendor, and it is
 * the one that needs no credential: Open-Meteo is keyless, which makes "live
 * weather" reachable before any account exists. The key belongs to the *other*
 * path — the normalised `weather_readings` table, which is where the server-side
 * ingest will put the same numbers when an API key exists.
 *
 * · Three rules are enforced here rather than left to the screen:
 *
 *   · a failure is reported, never thrown. The contract says a weather service
 *     that cannot be reached is a state the UI renders, not an exception it
 *     catches — the advice pauses and says why.
 *   · a missing number is `null`, never zero. Zero humidity is a fact; "the
 *     source did not report it" is not, and the UI renders them differently.
 *   · the provider's own vocabulary is translated at the boundary. Open-Meteo
 *     answers in WMO codes, so the code becomes both a catalogue key (when the
 *     app has a word for it) and the vendor's own text as a fallback.
 *
 * Times are requested in GMT and parsed as UTC on purpose. The farmer's clock and
 * the server's clock are different clocks, and a reading that arrives "five hours
 * old" because of an offset is how a stale reading gets presented as current.
 */

import type {
  GeoPoint,
  Sourced,
  WeatherDay,
  WeatherNow,
  WeatherProvider,
} from '../types';
import type { MessageKey } from '../../i18n/catalog';

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';

/** How old a reading may be before the app stops letting advice depend on it. */
const USABLE_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * WMO 4677 weather codes, as Open-Meteo reports them, reduced to the handful of
 * conditions a farmer's screen needs to name.
 */
const CONDITIONS: Readonly<Record<number, { text: string; key: MessageKey }>> = {
  0: { text: 'Clear sky', key: 'weather.condition.clear' },
  1: { text: 'Mainly clear', key: 'weather.condition.mainlyClear' },
  2: { text: 'Partly cloudy', key: 'weather.condition.partlyCloudy' },
  3: { text: 'Overcast', key: 'weather.condition.overcast' },
  45: { text: 'Fog', key: 'weather.condition.fog' },
  48: { text: 'Depositing rime fog', key: 'weather.condition.fog' },
  51: { text: 'Light drizzle', key: 'weather.condition.drizzle' },
  53: { text: 'Drizzle', key: 'weather.condition.drizzle' },
  55: { text: 'Dense drizzle', key: 'weather.condition.drizzle' },
  56: { text: 'Light freezing drizzle', key: 'weather.condition.drizzle' },
  57: { text: 'Freezing drizzle', key: 'weather.condition.drizzle' },
  61: { text: 'Light rain', key: 'weather.condition.rain' },
  63: { text: 'Rain', key: 'weather.condition.rain' },
  65: { text: 'Heavy rain', key: 'weather.condition.rain' },
  66: { text: 'Light freezing rain', key: 'weather.condition.rain' },
  67: { text: 'Freezing rain', key: 'weather.condition.rain' },
  71: { text: 'Light snow', key: 'weather.condition.snow' },
  73: { text: 'Snow', key: 'weather.condition.snow' },
  75: { text: 'Heavy snow', key: 'weather.condition.snow' },
  77: { text: 'Snow grains', key: 'weather.condition.snow' },
  80: { text: 'Light rain showers', key: 'weather.condition.showers' },
  81: { text: 'Rain showers', key: 'weather.condition.showers' },
  82: { text: 'Violent rain showers', key: 'weather.condition.showers' },
  85: { text: 'Snow showers', key: 'weather.condition.snow' },
  86: { text: 'Heavy snow showers', key: 'weather.condition.snow' },
  95: { text: 'Thunderstorm', key: 'weather.condition.thunderstorm' },
  96: { text: 'Thunderstorm with hail', key: 'weather.condition.thunderstorm' },
  99: { text: 'Thunderstorm with heavy hail', key: 'weather.condition.thunderstorm' },
};

/** Sixteen points, because a farmer reads "NW", not "315°". */
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

function compass(degrees: number | null): string | null {
  if (degrees === null || !Number.isFinite(degrees)) return null;
  const index = Math.round(((degrees % 360) + 360) % 360 / 22.5) % 16;
  return COMPASS[index] ?? null;
}

/** A number the source actually reported, or null. Never a stand-in for zero. */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `2026-10-03T07:15` in GMT, with or without seconds. */
function parseStamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const withSeconds = /T\d{2}:\d{2}$/.test(value) ? `${value}:00` : value;
  const parsed = Date.parse(`${withSeconds}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

const CURRENT_FIELDS = [
  'temperature_2m',
  'relative_humidity_2m',
  'apparent_temperature',
  'is_day',
  'wind_direction_10m',
  'wind_speed_10m',
  'precipitation',
  'weather_code',
].join(',');

const DAILY_FIELDS = [
  'temperature_2m_max',
  'temperature_2m_min',
  'precipitation_sum',
  'weather_code',
].join(',');

export function emptyWeatherNow(): WeatherNow {
  return {
    tempC: null,
    feelsLikeC: null,
    humidityPct: null,
    precipMm: null,
    windKph: null,
    windDir: null,
    conditionText: null,
  };
}

export class OpenMeteoWeatherProvider implements WeatherProvider {
  readonly name = 'Open-Meteo';

  constructor(
    /*
     * A wrapper, not `fetch` itself.
     *
     * `this.fetchImpl(url)` hands fetch a receiver that is not the global object,
     * and every Chromium-based browser brand-checks that receiver:
     * "Failed to execute 'fetch' on 'Window': Illegal invocation". Node and jsdom
     * do not enforce it, so a suite that injects fetch never sees the bug — the
     * app did, in every browser, on every call. The wrapper always calls fetch as
     * a plain function, and resolves it at call time so a test can swap the
     * global afterwards.
     */
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly endpoint: string = ENDPOINT,
    private readonly now: () => number = Date.now,
  ) {}

  /** The URL, exposed so a test can assert the request rather than the reply. */
  url(point: GeoPoint, query: string): string {
    const params = new URLSearchParams({
      latitude: String(point.lat),
      longitude: String(point.lon),
      timezone: 'GMT',
    });
    return `${this.endpoint}?${params.toString()}&${query}`;
  }

  private async get(point: GeoPoint, query: string): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(this.url(point, query));
    if (!response.ok) {
      throw new Error(`Open-Meteo answered ${response.status}.`);
    }
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object') {
      throw new Error('Open-Meteo returned something that is not a forecast.');
    }
    return body as Record<string, unknown>;
  }

  async current(point: GeoPoint): Promise<Sourced<WeatherNow>> {
    const fetchedAt = this.now();
    try {
      const body = await this.get(point, `current=${CURRENT_FIELDS}`);
      const current = (body.current ?? {}) as Record<string, unknown>;
      const observedAt = parseStamp(current.time) ?? fetchedAt;
      const code = num(current.weather_code);
      const condition = code === null ? undefined : CONDITIONS[code];

      return {
        data: {
          tempC: num(current.temperature_2m),
          feelsLikeC: num(current.apparent_temperature),
          humidityPct: num(current.relative_humidity_2m),
          precipMm: num(current.precipitation),
          windKph: num(current.wind_speed_10m),
          windDir: compass(num(current.wind_direction_10m)),
          /* The vendor's own wording is kept even when it is translated, so a
             locale without a key still shows a sentence rather than a code. */
          conditionText: condition?.text ?? null,
          conditionKey: condition?.key,
        },
        sourceLabel: this.name,
        observedAt,
        fetchedAt,
        freshness: fetchedAt - observedAt <= USABLE_AGE_MS ? 'fresh' : 'stale',
        status: 'live',
      };
    } catch (error) {
      return {
        data: emptyWeatherNow(),
        sourceLabel: this.name,
        observedAt: fetchedAt,
        fetchedAt,
        freshness: 'unavailable',
        status: 'failing',
        error: error instanceof Error ? error.message : 'Open-Meteo could not be reached.',
      };
    }
  }

  async forecast(point: GeoPoint, days: number): Promise<Sourced<WeatherDay[]>> {
    const fetchedAt = this.now();
    const wanted = Math.max(1, Math.min(Math.trunc(days), 16));
    try {
      const body = await this.get(
        point,
        `daily=${DAILY_FIELDS}&forecast_days=${wanted}`,
      );
      const daily = (body.daily ?? {}) as Record<string, unknown>;
      const times = Array.isArray(daily.time) ? daily.time : [];
      const maxes = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max : [];
      const mins = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min : [];
      const rain = Array.isArray(daily.precipitation_sum) ? daily.precipitation_sum : [];
      const codes = Array.isArray(daily.weather_code) ? daily.weather_code : [];

      const out: WeatherDay[] = [];
      for (let index = 0; index < times.length; index += 1) {
        const date = times[index];
        if (typeof date !== 'string') continue;
        const code = num(codes[index]);
        out.push({
          date,
          minC: num(mins[index]),
          maxC: num(maxes[index]),
          precipMm: num(rain[index]),
          conditionText: code === null ? null : (CONDITIONS[code]?.text ?? null),
        });
      }

      return {
        data: out,
        sourceLabel: this.name,
        observedAt: fetchedAt,
        fetchedAt,
        freshness: 'fresh',
        status: 'live',
      };
    } catch (error) {
      return {
        data: [],
        sourceLabel: this.name,
        observedAt: fetchedAt,
        fetchedAt,
        freshness: 'unavailable',
        status: 'failing',
        error: error instanceof Error ? error.message : 'Open-Meteo could not be reached.',
      };
    }
  }
}
