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
 * Two rules encoded here rather than left to callers:
 *
 *  · Persistence, weather and market are chosen together by the Supabase flag.
 *    They are all reads of the same normalised backend, so having one remote and
 *    another local would mean the app could contradict itself about the same
 *    fact.
 *
 *  · AI and OTP are chosen independently, because they are separate server
 *    endpoints that can be deployed at different times without pretending the
 *    rest of the backend exists.
 */

import { createContext, createElement, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { configurationReport, serviceConfig, type ServiceConfig } from './config';
import {
  DevelopmentAiProvider,
  DevelopmentAnalyticsProvider,
  DevelopmentDealerProvider,
  DevelopmentMarketProvider,
  DevelopmentOtpProvider,
  DevelopmentWeatherProvider,
  LocalRepository,
} from './providers/develop';
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

export function createServices(config: ServiceConfig = serviceConfig): Services {
  const backendLive = config.supabase.configured;

  const repository: Repository = backendLive ? new SupabaseRepository() : new LocalRepository();
  const weather: WeatherProvider = backendLive
    ? new SupabaseWeatherProvider()
    : new DevelopmentWeatherProvider();
  const market: MarketProvider = backendLive
    ? new SupabaseMarketProvider()
    : new DevelopmentMarketProvider();
  const dealer: DealerProvider = backendLive
    ? new SupabaseDealerProvider()
    : new DevelopmentDealerProvider();
  const ai: AiProvider = config.aiEndpoint.configured
    ? new RemoteAiProvider()
    : new DevelopmentAiProvider();
  const otp: OtpProvider = config.otpEndpoint.configured
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
  return configurationReport()
    .map(({ service, mode }) => `${service}: ${mode}`)
    .join(' · ')
    .concat(services.anyRemote ? '' : ' (no backend configured)');
}
