/**
 * Provider registry.
 *
 * The single place that decides which implementation of each service is live.
 * Screens and stores never construct a provider and never import a vendor; they
 * ask for a capability through `useServices()`.
 *
 * Selection is driven entirely by configuration, so the same build runs in
 * development mode on a device with no backend and in production against the
 * real one. Nothing in the product flow knows the difference — which is the
 * requirement, stated in the brief as: swapping the provider must not require
 * redesigning the feature.
 *
 * Rules encoded here rather than left to callers:
 *
 *  · Persistence, market and the `auto` weather choice follow the Supabase flag
 *    together. They are reads of the same normalised backend, so having one
 *    remote and another local would let the app contradict itself about the same
 *    fact.
 *
 *  · Weather may be pointed at Open-Meteo instead, explicitly, through
 *    `VITE_WEATHER_PROVIDER`. That provider needs no credential, so it is how
 *    live weather arrives before the backend exists — and because the choice is
 *    named rather than guessed, an unconfigured build still makes no network
 *    calls at all.
 *
 *  · AI and OTP are chosen independently, because they are separate server
 *    endpoints that can be deployed at different times without pretending the
 *    rest of the backend exists.
 */

import { createContext, createElement, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { configurationReport, resolveProviders, serviceConfig, type ServiceConfig } from './config';
import {
  DevelopmentAiProvider,
  DevelopmentAnalyticsProvider,
  DevelopmentDealerProvider,
  DevelopmentMarketProvider,
  DevelopmentOtpProvider,
  DevelopmentWeatherProvider,
  LocalRepository,
} from './providers/develop';
import { MarketplaceDealerProvider } from './providers/marketplace';
import { ChainedDealerProvider } from './providers/fallback';
import { OpenMeteoWeatherProvider } from './providers/openMeteo';
import { SupabaseOtpProvider } from './providers/supabaseAuth';
import { DemoOtpProvider } from './providers/demoAuth';
import { demoAuth, type DemoAuthConfig } from './demoAuth';
import {
  RemoteAiProvider,
  RemoteAnalyticsProvider,
  RemoteOtpProvider,
  SupabaseDealerProvider,
  SupabaseMarketProvider,
  SupabaseRepository,
  SupabaseWeatherProvider,
} from './providers/remote';
import { attachRepository } from './persistence';
import type {
  AiProvider,
  AnalyticsProvider,
  DealerProvider,
  MarketProvider,
  OtpProvider,
  Repository,
  WeatherProvider,
} from './types';

export type Services = {
  repository: Repository;
  weather: WeatherProvider;
  market: MarketProvider;
  ai: AiProvider;
  otp: OtpProvider;
  dealer: DealerProvider;
  analytics: AnalyticsProvider;
  config: ServiceConfig;
  /** Whether any part of the stack is running against the real backend. */
  anyRemote: boolean;
};

export function createServices(
  config: ServiceConfig = serviceConfig,
  /**
   * The development demo identities, or null for the ordinary providers.
   *
   * Defaulted rather than required because it is null in every production build:
   * `demoAuth()` is gated on `import.meta.env.DEV`, so a shipped bundle resolves
   * it to null without any caller having to remember. Injectable so a test can
   * drive the demo path without a developer's environment. */
  demo: DemoAuthConfig | null = demoAuth(),
): Services {
  const backendLive = config.supabase.configured;
  /* Verification and shops are resolved in one place, shared with the diagnostics
     panel — see `resolveProviders`, which exists precisely so the two cannot
     disagree about which provider is running. */
  const resolved = resolveProviders(config, demo !== null);

  const repository: Repository = backendLive ? new SupabaseRepository() : new LocalRepository();
  /*
   * Three ways to get a reading, and the choice is configuration, not code that
   * branches later. The normalised table is preferred when there is a backend;
   * the vendor directly is the keyless path; the fixture is what the tests and an
   * unconfigured build use.
   */
  const weather: WeatherProvider =
    config.weather.provider === 'supabase'
      ? new SupabaseWeatherProvider()
      : config.weather.provider === 'open-meteo'
        ? new OpenMeteoWeatherProvider()
        : new DevelopmentWeatherProvider();
  const market: MarketProvider = backendLive
    ? new SupabaseMarketProvider()
    : new DevelopmentMarketProvider();
  /*
   * With a backend there are two shop systems, and the list asks the app's own
   * dealer projection first: it is the one the rest of the app reads, so the Shop
   * tab, the scan screen and a shop's own page cannot disagree about where the
   * farmer can buy something. The marketplace answers only when the dealer system
   * has no shop in range — see `providers/fallback` for why an empty answer does
   * not end the question.
   */
  const dealer: DealerProvider =
    resolved.dealer === 'marketplace'
      ? backendLive
        ? /*
           * The live dealer network first, the app's own projection second.
           *
           * The order was the other way round, on the argument that the
           * projection is what the rest of the app reads. On staging that meant a
           * farmer in Lahore saw four seeded reference shops 70–100 km away while
           * the dealer platform held a real Lahore branch 12 km away with an
           * approved listing — the projection answered, so the marketplace was
           * never asked. The projection is now the fallback: it is where a shop
           * this app already knows (a connected shop, a synced profile) still
           * appears when the network is unreachable. See `providers/fallback` for
           * why an empty answer does not end the question either way.
           */
          new ChainedDealerProvider([new MarketplaceDealerProvider(), new SupabaseDealerProvider()])
        : new MarketplaceDealerProvider()
      : resolved.dealer === 'supabase'
        ? new SupabaseDealerProvider()
        : new DevelopmentDealerProvider();
  const ai: AiProvider = config.aiEndpoint.configured
    ? new RemoteAiProvider()
    : new DevelopmentAiProvider();
  const otp: OtpProvider =
    resolved.otp === 'demo'
      ? new DemoOtpProvider(demo as DemoAuthConfig)
      : resolved.otp === 'supabase'
        ? new SupabaseOtpProvider()
        : resolved.otp === 'gateway'
          ? new RemoteOtpProvider()
          : new DevelopmentOtpProvider();
  const analytics: AnalyticsProvider = config.analytics.configured
    ? new RemoteAnalyticsProvider()
    : new DevelopmentAnalyticsProvider();

  return {
    repository,
    weather,
    market,
    ai,
    otp,
    dealer,
    analytics,
    config,
    anyRemote:
      backendLive ||
      config.marketplace.configured ||
      config.aiEndpoint.configured ||
      config.otpEndpoint.configured ||
      config.dealerEndpoint.configured ||
      config.analytics.configured,
  };
}

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider({
  children,
  services,
}: {
  children: ReactNode;
  /** Injectable so tests can supply a deterministic set of providers. */
  services?: Services;
}) {
  const value = useMemo(() => services ?? createServices(), [services]);
  /*
   * The queue that retries failed writes lives outside React, so it is told which
   * repository is live rather than reading the context. Effects run innermost
   * first, so a store's first write is queued while this is still pending; the
   * attach call drains it. Nothing is lost in between.
   */
  useEffect(() => {
    attachRepository(value.repository);
  }, [value.repository]);
  return createElement(ServicesContext.Provider, { value }, children);
}

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (!services) {
    throw new Error('useServices must be used inside a ServicesProvider');
  }
  return services;
}

/**
 * The same lookup, with a working default instead of a throw.
 *
 * Used by the two places that must never take the whole app down: the document
 * layer, where the device's own repository is a safe answer, and the identity
 * sheet, which has to be able to send a code for anything in the app to be
 * writable at all. A screen rendered in isolation, or a provider accidentally
 * left out of a tree, should still show the farmer something usable rather than a
 * blank page and an exception in the console.
 *
 * Screens still use the strict lookup: a screen reading a service it was not
 * given is a wiring mistake, and failing loudly is right there.
 */
const fallbackServices: Services = createServices();

export function useServicesOrDefault(): Services {
  return useContext(ServicesContext) ?? fallbackServices;
}

/**
 * A human-readable summary of what is live, for the diagnostics panel.
 *
 * Generated from the running configuration rather than written by hand, so it
 * cannot claim a provider is connected when it is not.
 */
export function serviceSummary(services: Services): string {
  /* Asked of the providers it was actually given, so the summary describes the
     running app rather than a second guess at which one defaulted in. */
  return configurationReport(services.config, services.otp instanceof DemoOtpProvider)
    .map(({ service, mode }) => `${service}: ${mode}`)
    .join(' · ')
    .concat(services.anyRemote ? '' : ' (no backend configured)');
}
