/**
 * Service configuration.
 *
 * One place reads the environment, and everything else asks this module, so that
 * "is the backend configured?" has exactly one answer. A screen using a remote
 * provider while the session store uses local storage is the kind of split that
 * produces data loss nobody can reproduce.
 *
 * SECURITY — read this before adding a key.
 *
 * Anything named `VITE_*` is inlined into the JavaScript bundle and therefore
 * shipped inside the APK, where anyone can read it. So this file deliberately
 * does NOT contain a WeatherAPI key, an AI key, an SMS provider secret, or a
 * dealer-system token. Those are server-side secrets and live as Edge Function
 * secrets, never in the client.
 *
 * The one credential that legitimately belongs here is the Supabase anon key,
 * which is designed to be public: it grants nothing on its own, because every
 * table is behind row level security that checks `auth.uid()`. If a key you are
 * about to add is not safe to publish on a billboard, it does not go in this
 * file.
 *
 * Client configuration therefore consists of:
 *   · where the backend is (Supabase URL + anon key)
 *   · where our own server endpoints are (Edge Functions)
 *
 * The vendor keys are used by the ingestion and dispatch functions on the
 * server, not by the app.
 */

/**
 * Where the weather numbers come from.
 *
 * · `supabase` — the normalised `weather_readings` table, filled by the ingest
 *   function. The destination, because the UI and the assistant then read the
 *   same stored reading.
 * · `open-meteo` — the vendor directly, from the client. Keyless, so live weather
 *   works before any account exists; chosen explicitly rather than guessed.
 * · `development` — the fixture, which is what the tests run against.
 *
 * `auto` (the default) means "the normalised table if there is a backend,
 * otherwise the fixture": an unconfigured build must never silently start making
 * network calls.
 */
export type WeatherSource = 'auto' | 'development' | 'open-meteo' | 'supabase';

export type ServiceConfig = {
  supabase: { url: string | null; anonKey: string | null; configured: boolean };
  /** Our Edge Functions. Each may be unconfigured independently. */
  aiEndpoint: { url: string | null; configured: boolean };
  otpEndpoint: { url: string | null; configured: boolean };
  dealerEndpoint: { url: string | null; configured: boolean };
  /** The ingestion function. Server-side work the app triggers, never reads. */
  weatherIngestEndpoint: { url: string | null; configured: boolean };
  analytics: { key: string | null; host: string; configured: boolean };
  /** The source the registry will actually use, already resolved. */
  weather: { provider: Exclude<WeatherSource, 'auto'> };
};

function read(key: string): string | null {
  // import.meta.env is statically replaced by Vite. Reading through a helper
  // keeps the variable allowlist in one place, so a mistyped name shows up as
  // "unconfigured" rather than as a silently undefined dependency.
  const value = (import.meta.env as Record<string, string | undefined>)[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function build(): ServiceConfig {
  const supabaseUrl = read('VITE_SUPABASE_URL');
  const supabaseAnonKey = read('VITE_SUPABASE_ANON_KEY');
  const aiEndpoint = read('VITE_AI_ENDPOINT');
  const otpEndpoint = read('VITE_OTP_ENDPOINT');
  const dealerEndpoint = read('VITE_DEALER_ENDPOINT');
  const weatherIngestEndpoint = read('VITE_WEATHER_INGEST_ENDPOINT');
  const analyticsKey = read('VITE_POSTHOG_KEY');
  const requestedWeather = read('VITE_WEATHER_PROVIDER');
  const backendLive = Boolean(supabaseUrl && supabaseAnonKey);

  return {
    supabase: {
      url: supabaseUrl,
      anonKey: supabaseAnonKey,
      // Both halves are required. A URL without a key would produce a confusing
      // 401 rather than a clear switch to development mode.
      configured: backendLive,
    },
    weather: {
      provider:
        requestedWeather === 'open-meteo' ||
        requestedWeather === 'development' ||
        requestedWeather === 'supabase'
          ? requestedWeather
          : backendLive
            ? 'supabase'
            : 'development',
    },
    aiEndpoint: { url: aiEndpoint, configured: Boolean(aiEndpoint) },
    otpEndpoint: { url: otpEndpoint, configured: Boolean(otpEndpoint) },
    dealerEndpoint: { url: dealerEndpoint, configured: Boolean(dealerEndpoint) },
    weatherIngestEndpoint: {
      url: weatherIngestEndpoint,
      configured: Boolean(weatherIngestEndpoint),
    },
    analytics: {
      key: analyticsKey,
      host: read('VITE_POSTHOG_HOST') ?? 'https://eu.i.posthog.com',
      configured: Boolean(analyticsKey),
    },
  };
}

export const serviceConfig: ServiceConfig = build();

/**
 * What is running in development mode right now.
 *
 * Exported as data, so the alignment ledger and the diagnostics panel are
 * generated from the running configuration rather than written by hand and
 * quietly going stale.
 */
export function configurationReport(): Array<{ service: string; mode: 'remote' | 'development' }> {
  const remote = (on: boolean): 'remote' | 'development' => (on ? 'remote' : 'development');
  return [
    { service: 'persistence', mode: remote(serviceConfig.supabase.configured) },
    // Weather is reported from its own resolved choice, not from the database
    // flag: a build reading the live vendor with no backend is still live.
    { service: 'weather', mode: remote(serviceConfig.weather.provider !== 'development') },
    { service: 'market', mode: remote(serviceConfig.supabase.configured) },
    { service: 'ai', mode: remote(serviceConfig.aiEndpoint.configured) },
    { service: 'otp', mode: remote(serviceConfig.otpEndpoint.configured) },
    { service: 'dealer', mode: remote(serviceConfig.dealerEndpoint.configured) },
    // The ingestion function is remote work the app triggers, not a source it
    // reads, so it is reported separately from `weather`.
    { service: 'weather-ingest', mode: remote(serviceConfig.weatherIngestEndpoint.configured) },
    { service: 'analytics', mode: remote(serviceConfig.analytics.configured) },
  ];
}
