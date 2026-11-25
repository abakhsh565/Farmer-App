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
 * The demo credential is read in `services/demoAuth.ts` rather than in `BUILD_ENV`
 * above, and that is deliberate: everything in this file must be safe to publish
 * on a billboard, and a demo password is not. It is imported here only to answer
 * "which provider is running", which the diagnostics panel needs.
 */
import { demoAuth } from './demoAuth';
import { resolveAppBackend } from './appEnvironments';
import { resolveShopEnvironment } from './shopEnvironments';

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

export type ShopApiConfig = { url: string | null; key: string | null; configured: boolean };

export type ServiceConfig = {
  supabase: { url: string | null; anonKey: string | null; configured: boolean };
  /**
   * The production marketplace the Shop tab reads.
   *
   * A different project from the app's own backend, with its own anonymous key,
   * because it publishes a different thing: what shops have listed, read-only. It
   * is chosen independently so a build can have live listings without a live
   * account backend — and so the shop data can be pointed at production while
   * everything else stays where it is.
   */
  marketplace: { url: string | null; key: string | null; configured: boolean };
  /**
   * The shop app's own backend — where the conversation with the shop lives.
   *
   * A third project, and a third key, because it is a third fact: the shop app is
   * the server for the messages, credit asks and visits — the `farmer_api_*`
   * contract — and this app is a client of it. The key is that
   * project's anonymous key, which is public by design; the farmer's own
   * credential — a token the shop issues — travels as a parameter, never here.
   *
   * Deliberately *not* defaulted to the marketplace project: a build without these
   * two values keeps the on-device conversation it has today rather than pointing
   * at a project that has never heard of `farmer_api_*`.
   */
  shopApi: ShopApiConfig;
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

/**
 * Every value the client can read from the build, listed one by one.
 *
 * These are written out literally on purpose. Vite replaces only *statically
 * written* `import.meta.env.NAME` references when it builds, and a lookup by
 * variable name — `import.meta.env[key]` — is not replaced at all. That failure
 * is silent: the app builds cleanly, ships, and then reports itself
 * "unconfigured" for the backend, the AI and analytics at the same time, with
 * nothing in the console to explain it. Writing each key out is what lets Vite
 * see them.
 *
 * Adding a variable here is the only supported way to read one. The `test.env`
 * block in `vite.config.ts` must list it too, so a developer's `.env.local`
 * cannot make the suite talk to a real project.
 */
const BUILD_ENV = {
  VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
  VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY,
  VITE_MARKETPLACE_URL: import.meta.env.VITE_MARKETPLACE_URL,
  VITE_MARKETPLACE_KEY: import.meta.env.VITE_MARKETPLACE_KEY,
  VITE_SHOP_API_URL: import.meta.env.VITE_SHOP_API_URL,
  VITE_SHOP_API_KEY: import.meta.env.VITE_SHOP_API_KEY,
  // Names the environment this build is for (`dev`, `staging`, `production`).
  // It selects which AgriShop project the shop and marketplace endpoints come
  // from — see `shopEnvironments.ts` — as well as the OTA channel the APK follows.
  VITE_APP_ENV: import.meta.env.VITE_APP_ENV,
  VITE_AI_ENDPOINT: import.meta.env.VITE_AI_ENDPOINT,
  VITE_OTP_ENDPOINT: import.meta.env.VITE_OTP_ENDPOINT,
  VITE_DEALER_ENDPOINT: import.meta.env.VITE_DEALER_ENDPOINT,
  VITE_WEATHER_INGEST_ENDPOINT: import.meta.env.VITE_WEATHER_INGEST_ENDPOINT,
  VITE_WEATHER_PROVIDER: import.meta.env.VITE_WEATHER_PROVIDER,
  VITE_ANALYTICS_KEY: import.meta.env.VITE_ANALYTICS_KEY,
  // Read only as a fallback for deployments configured before the rename.
  VITE_POSTHOG_KEY: import.meta.env.VITE_POSTHOG_KEY,
  VITE_POSTHOG_HOST: import.meta.env.VITE_POSTHOG_HOST,
} satisfies Record<string, string | undefined>;

type BuildEnvKey = keyof typeof BUILD_ENV;

function read(key: BuildEnvKey): string | null {
  const value = BUILD_ENV[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function build(): ServiceConfig {
  /*
   * Which project this build belongs to is decided by `VITE_APP_ENV`, not by
   * whatever happens to be in the build environment.
   *
   * This is the same rule the shop network already follows, and it is the rule
   * that makes three environments possible at all: a staging build made on a
   * developer's machine must read staging even though that machine's `.env.local`
   * points at a local stack, and a production build must read production even
   * when it is built by CI, where no `.env.local` exists. `dev` is the one
   * environment that does read `VITE_SUPABASE_*`, because dev's backend is the
   * developer's own machine by definition.
   *
   * `local` means no backend: the on-device repository, the fixture weather and
   * the development sign-in. That is what an unlabelled build gets, so a build
   * nobody labelled can never start writing into a live database.
   */
  const appBackend = resolveAppBackend(read('VITE_APP_ENV'));
  const supabaseUrl =
    appBackend.source === 'environment' ? appBackend.backend.url : appBackend.source === 'configured' ? read('VITE_SUPABASE_URL') : null;
  const supabaseAnonKey =
    appBackend.source === 'environment' ? appBackend.backend.key : appBackend.source === 'configured' ? read('VITE_SUPABASE_ANON_KEY') : null;
  /*
   * The shop network is a different project per environment, so its addresses are
   * resolved from `VITE_APP_ENV` first and from an explicit variable second. The
   * other order would be worse: every build path here already sets the environment,
   * and only some of them are configured for shop credentials — a staging build
   * that silently read production's listings would look like it worked.
   */
  const shopEnvironment = resolveShopEnvironment(read('VITE_APP_ENV'));
  const marketplaceUrl = read('VITE_MARKETPLACE_URL') ?? shopEnvironment?.marketplace.url ?? null;
  const marketplaceKey = read('VITE_MARKETPLACE_KEY') ?? shopEnvironment?.marketplace.key ?? null;
  const shopApiUrl = read('VITE_SHOP_API_URL') ?? shopEnvironment?.shopApi.url ?? null;
  const shopApiKey = read('VITE_SHOP_API_KEY') ?? shopEnvironment?.shopApi.key ?? null;
  const aiEndpoint = read('VITE_AI_ENDPOINT');
  const otpEndpoint = read('VITE_OTP_ENDPOINT');
  const dealerEndpoint = read('VITE_DEALER_ENDPOINT');
  const weatherIngestEndpoint = read('VITE_WEATHER_INGEST_ENDPOINT');
  // `VITE_ANALYTICS_KEY` is the name to use: it describes what the key does
  // rather than which vendor issued it, and a one-word name is far harder to
  // mistype than a compound one — which is exactly how the original spelling
  // went wrong three times in a row when it was entered by hand. The vendor
  // name stays in `host`, where it belongs.
  //
  // `VITE_POSTHOG_KEY` is still read as a fallback so a deployment configured
  // before the rename keeps sending events.
  const analyticsKey = read('VITE_ANALYTICS_KEY') ?? read('VITE_POSTHOG_KEY');
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
    marketplace: {
      url: marketplaceUrl,
      key: marketplaceKey,
      configured: Boolean(marketplaceUrl && marketplaceKey),
    },
    shopApi: {
      url: shopApiUrl,
      key: shopApiKey,
      configured: Boolean(shopApiUrl && shopApiKey),
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
      // The vendor lives here rather than in the variable name, so changing
      // analytics provider does not mean renaming an environment variable on
      // every deployment.
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
/**
 * Which implementation each independently-choosable service resolves to.
 *
 * Two callers need this answer and they must not work it out separately: the
 * registry, which builds the provider, and the diagnostics panel, which says which
 * provider is running. They *were* worked out twice, and they disagreed — the panel
 * read the raw endpoint flags while the registry preferred a configured backend, so
 * a farmer whose app was demonstrably verifying numbers through Supabase Auth was
 * shown "Otp — Development" next to it, and a "shop data is live" line that had
 * stopped meaning anything. One function, one answer.
 */
export type OtpChoice = 'demo' | 'supabase' | 'gateway' | 'development';
export type DealerChoice = 'marketplace' | 'supabase' | 'development';

export function resolveProviders(
  config: ServiceConfig = serviceConfig,
  /**
   * Whether a development demo sign-in is available, passed in rather than read
   * here: the demo credential deliberately does not belong to `ServiceConfig`
   * (see `services/demoAuth.ts`), and this function must stay a pure decision over
   * what it is given.
   */
  demo: boolean = false,
): {
  otp: OtpChoice;
  dealer: DealerChoice;
} {
  const backendLive = config.supabase.configured;

  return {
    /*
     * Verification is chosen by what can issue a *session*, not by what can send a
     * code. Supabase Auth is the only one of the two that produces an access token,
     * and without one every row-level policy in the database matches nothing — a
     * farmer would be signed in and own an empty app. Our own gateway remains the
     * provider for a deployment that has the OTP function but not Supabase Auth, and
     * the development provider is the last resort.
     */
    /*
     * Demo wins when it is available, because it is only ever available in a
     * development build *and* only when the demo accounts are configured — and
     * when both hold, the farmer's alternative is a code that cannot be
     * delivered at all. It still issues a real session, so it is not a lesser
     * path, only a differently-sourced code.
     */
    otp: demo
      ? 'demo'
      : backendLive
        ? 'supabase'
        : config.otpEndpoint.configured
          ? 'gateway'
          : 'development',
    /*
     * The app's own dealer system is the primary source once there is a backend,
     * and the marketplace completes it; the fixture covers a build with neither.
     *
     * This used to read the other way round — the marketplace won whenever it was
     * configured — and that was wrong in a way that showed: `dealer_profiles` is
     * where the shops this app knows are recorded, and the same table feeds the
     * scan screen's stockist list and the shop's own page. Preferring the
     * marketplace meant the Shop tab could show a different set of shops from the
     * rest of the app, and showed *none* while the farmer's own shops sat in the
     * database. The chain in `providers/fallback` asks the dealer system first and
     * falls through to the marketplace only when it has nothing near the farmer,
     * so the choice here is still one decision made in one place.
     */
    dealer: config.marketplace.configured
      ? 'marketplace'
      : backendLive
        ? 'supabase'
        : 'development',
  };
}

/**
 * What is running in development mode right now.
 *
 * Exported as data, so the alignment ledger and the diagnostics panel are
 * generated from the running configuration rather than written by hand and
 * quietly going stale.
 */
export function configurationReport(
  config: ServiceConfig = serviceConfig,
  /** Must match what the registry was given, or the panel describes a different app. */
  demo: boolean = demoAuth() !== null,
): Array<{ service: string; mode: 'remote' | 'development' }> {
  const resolved = resolveProviders(config, demo);
  const remote = (on: boolean): 'remote' | 'development' => (on ? 'remote' : 'development');
  return [
    { service: 'persistence', mode: remote(config.supabase.configured) },
    // Weather is reported from its own resolved choice, not from the database
    // flag: a build reading the live vendor with no backend is still live.
    { service: 'weather', mode: remote(config.weather.provider !== 'development') },
    { service: 'market', mode: remote(config.supabase.configured) },
    { service: 'ai', mode: remote(config.aiEndpoint.configured) },
    /*
     * Both of these report their *resolved* provider, for the same reason weather
     * does: a build with a backend signs in through Supabase Auth and reads shops
     * from the database even when neither Edge Function is named, and reporting
     * "Development" beside a screen that is doing both is the panel contradicting
     * the app it is describing.
     */
    /*
     * The demo provider signs in for real, so it would be tempting to call it
     * remote. It is reported as development instead, and that is the honest
     * answer to the question this row asks: is a code being *delivered* to this
     * farmer, or is it on their screen? Only the two server providers send one.
     */
    { service: 'otp', mode: remote(resolved.otp === 'supabase' || resolved.otp === 'gateway') },
    { service: 'dealer', mode: remote(resolved.dealer !== 'development') },
    // The ingestion function is remote work the app triggers, not a source it
    // reads, so it is reported separately from `weather`.
    { service: 'weather-ingest', mode: remote(config.weatherIngestEndpoint.configured) },
    { service: 'analytics', mode: remote(config.analytics.configured) },
  ];
}
