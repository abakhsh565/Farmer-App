import { describe, expect, it } from 'vitest';

import { initAnalytics, sanitise } from './analytics';
import { serviceConfig } from './config';

/**
 * Analytics tests.
 *
 * These cover the privacy guarantees, not the wire format. Sending an event is
 * verified for real in production by watching one arrive in the PostHog live
 * feed; what cannot be verified that way is that a phone number *never* leaves,
 * so that is what is asserted here.
 *
 * The suite runs with no analytics key configured, which is also the production
 * case for any build that has not been given one. Every test below therefore
 * exercises the same no-op path a developer or a CI machine runs.
 */
describe('analytics', () => {
  it('is inert when no key is configured', () => {
    // The suite has no analytics key, so this is the unconfigured shape.
    expect(serviceConfig.analytics.configured).toBe(false);

    const analytics = initAnalytics();

    expect(analytics.configured).toBe(false);
    // Must not throw, must not fetch, must not queue anything.
    expect(() => analytics.track('app_opened')).not.toThrow();
    expect(() => analytics.screen('home')).not.toThrow();
  });

  it('is safe to call repeatedly, because screens instrument unconditionally', () => {
    const analytics = initAnalytics();

    expect(() => {
      analytics.screen('scan');
      analytics.screen('scan');
      analytics.track('scan_started', { source: 'camera' });
    }).not.toThrow();
  });
});

/**
 * The deny-list is the whole privacy story, so it is asserted directly rather
 * than inferred from "nothing crashed".
 */
describe('analytics property sanitising', () => {
  it('drops properties whose name identifies a person', () => {
    const safe = sanitise({
      screen: 'scan',
      phone: '923001234567',
      mobile: '0300',
      otp: '123456',
      code: '123456',
      farmer_name: 'Ali',
      email: 'ali@example.com',
      contact: '0300-1234567',
      lat: 32.18,
      lon: 74.19,
      location: 'Gujranwala',
      refresh_token: 'abc',
    });

    expect(safe).toEqual({ screen: 'scan' });
  });

  it('drops a value that is a phone number even under a harmless name', () => {
    const safe = sanitise({ screen: 'scan', label: '923001234567' });

    expect(safe).toEqual({ screen: 'scan' });
  });

  it('keeps ordinary, non-identifying values', () => {
    const safe = sanitise({
      screen: 'scan',
      source: 'camera',
      duration_ms: 4200,
      outcome: 'diagnosed',
      confidence: 0.82,
      has_photo: true,
    });

    expect(safe).toEqual({
      screen: 'scan',
      source: 'camera',
      duration_ms: 4200,
      outcome: 'diagnosed',
      confidence: 0.82,
      has_photo: true,
    });
  });

  it('treats absent properties as an empty payload rather than undefined', () => {
    expect(sanitise(undefined)).toEqual({});
  });
});