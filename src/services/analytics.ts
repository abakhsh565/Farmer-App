/**
 * Product analytics.
 *
 * Answers one question: which parts of the app do farmers actually use, and
 * where do they give up. Nothing more. It is deliberately not a tracking
 * system.
 *
 * PRIVACY — the rule this module exists to enforce.
 *
 * In this app a person's identity *is* their phone number. So this module has
 * three hard rules, not three good intentions:
 *
 *   1. Events are anonymous. There is no `identify()` exported on purpose, and
 *      PostHog is initialised with `person_profiles: 'never'`, so no person
 *      profile is ever built. A session cannot be joined across devices or
 *      traced back to a farmer.
 *   2. Nothing that looks like a phone number, an OTP code, a name or a
 *      location can leave the device — `track()` drops those properties rather
 *      than trusting the caller to remember. The screen-view path strips them
 *      too, because a URL is attacker- and accident-controlled.
 *   3. Autocapture and session replay are off. Autocapture would quietly
 *      harvest input fields — exactly where a one-time code is typed. Replay
 *      would record a farmer's screen while they handle their own land and
 *      finances, which is not ours to record.
 *
 * WHY A LAZY IMPORT.
 *
 * The SDK is only imported when a key is configured. An unconfigured build
 * therefore never downloads or initialises it — which matters here, because
 * farmers on patchy mobile data should not pay for an analytics SDK they are
 * not getting insight from, and a build with no key must make zero network
 * calls on start-up.
 *
 * When the key is absent every function here is a no-op. Callers can therefore
 * instrument freely without guarding each call, and the test suite exercises
 * the same code path as production.
 */

import { serviceConfig } from './config';

/**
 * Events we record.
 *
 * A closed union rather than `string`, so a typo is a compile error instead of a
 * dashboard with a misspelled series nobody notices for a month.
 */
export type AnalyticsEvent =
  | 'app_opened'
  | 'screen_viewed'
  | 'scan_started'
  | 'scan_completed'
  | 'advice_requested'
  | 'advice_not_covered'
  | 'weather_viewed'
  | 'market_rates_viewed'
  | 'dealer_searched'
  | 'credit_request_opened'
  | 'credit_submitted'
  | 'field_visit_requested'
  | 'community_posted'
  | 'offline_action_queued';

export type AnalyticsProperties = Record<string, string | number | boolean | null | undefined>;

export type Analytics = {
  /** False when no key is configured. Callers do not need to check it. */
  readonly configured: boolean;
  /**
   * Record a product event. Property values that look like personal data are
   * dropped — silently, because a thrown error here would break a farmer's
   * screen to satisfy a privacy rule.
   */
  track(event: AnalyticsEvent, properties?: AnalyticsProperties): void;
  /** Convenience for `screen_viewed`, named for what the caller means. */
  screen(name: string): void;
};

const noop: Analytics = {
  configured: false,
  track: () => undefined,
  screen: () => undefined,
};

/**
 * Property names that must never be sent, matched case-insensitively.
 *
 * This is a deny-list rather than an allow-list because an allow-list would need
 * a code change every time someone adds a useful property, and the failure mode
 * of that is a leak. The deny-list fails closed for the specific things that
 * identify a person here, and everything else is inert by inspection.
 */
const FORBIDDEN_PROPERTY = /(phone|mobile|msisdn|otp|code|password|name|email|contact|lat|lng|lon|location|address|otp_hash|refresh_token)/i;

/** A bare digit run of 8+, which is what a Pakistani number looks like. */
const LOOKS_LIKE_A_NUMBER = /^\+?\d[\d\s-]{7,}$/;

/** Screen names are identifiers, not user text — keep them to a safe alphabet. */
const SAFE_SCREEN_NAME = /^[a-z0-9_-]{1,64}$/i;

/**
 * Drop anything that looks like personal data.
 *
 * Returns the properties that are safe to send. A dropped key is not reported
 * back to the caller: analytics must never become a way to interrogate the app
 * about what it is trying to collect.
 */
export function sanitise(properties: AnalyticsProperties | undefined): Record<string, string | number | boolean> {
  if (!properties) return {};

  const safe: Record<string, string | number | boolean> = {};

  for (const [key, value] of Object.entries(properties)) {
    if (value === null || value === undefined) continue;
    if (FORBIDDEN_PROPERTY.test(key)) continue;
    if (typeof value === 'string' && LOOKS_LIKE_A_NUMBER.test(value.trim())) continue;
    safe[key] = value;
  }

  return safe;
}

/**
 * Initialise analytics.
 *
 * Safe to call unconditionally at start-up. Returns the no-op implementation
 * when no key is configured, so an unconfigured or offline build costs nothing
 * and fails silently rather than at the login screen.
 */
export function initAnalytics(): Analytics {
  const { key, host } = serviceConfig.analytics;

  if (!key) return noop;

  let started = false;

  return {
    configured: true,

    track(event, properties) {
      // Imported on first use rather than at module load, so a build without a
      // key never downloads or runs the SDK. The failure path is swallowed:
      // analytics must never be the reason a farmer cannot open the app.
      void import('posthog-js')
        .then(({ default: posthog }) => {
          if (!started) {
            posthog.init(key, {
              api_host: host,
              // No person profiles: identity here is a phone number, and this
              // module refuses to let one become an analytics identity.
              person_profiles: 'never',
              // Autocapture would quietly harvest input fields, which is
              // exactly where a one-time code is typed.
              autocapture: false,
              capture_pageview: false,
              capture_pageleave: false,
              // Session replay would film a farmer handling their own land and
              // credit details. Off, permanently, not just by default.
              disable_session_recording: true,
              capture_exceptions: false,
              advanced_disable_flags: true,
              request_batching: true,
              persistence: 'localStorage',
            });
            started = true;
          }
          posthog.capture(event, sanitise(properties));
        })
        .catch(() => undefined);
    },

    screen(name) {
      // A screen name is a constant in our own code, but sanitising it anyway
      // means a future dynamic route cannot leak a query string by accident.
      const safeName = SAFE_SCREEN_NAME.test(name) ? name.toLowerCase() : 'unknown';
      this.track('screen_viewed', { screen: safeName });
    },
  };
}