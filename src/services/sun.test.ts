import { describe, expect, it } from 'vitest';
import { daylightProgress, sunTimes } from './sun';

/** Lahore, early November — a place and season this app actually serves. */
const LAHORE = { lat: 31.5497, lon: 74.3436 };
const DAY = new Date(Date.UTC(2026, 10, 3));

describe('sunTimes', () => {
  it('puts sunrise before noon before sunset', () => {
    const times = sunTimes(DAY, LAHORE);
    expect(times).not.toBeNull();
    expect(times!.sunrise).toBeLessThan(times!.solarNoon);
    expect(times!.solarNoon).toBeLessThan(times!.sunset);
  });

  it('gives a November day in Lahore a plausible length', () => {
    const times = sunTimes(DAY, LAHORE)!;
    const hours = (times.sunset - times.sunrise) / 3_600_000;
    // About 10h 50m; allow a wide band so this tests the method, not the minute.
    expect(hours).toBeGreaterThan(9.5);
    expect(hours).toBeLessThan(12);
    expect(times.sunrise).toBeGreaterThan(DAY.getTime());
    expect(times.sunset).toBeLessThan(DAY.getTime() + 86_400_000);
  });

  it('returns nothing where the sun does not cross the horizon', () => {
    expect(sunTimes(DAY, { lat: 80, lon: 20 })).toBeNull();
  });
});

describe('daylightProgress', () => {
  it('runs from 0 at sunrise to 1 at sunset and clamps outside', () => {
    const times = sunTimes(DAY, LAHORE)!;
    expect(daylightProgress(times.sunrise, times)).toBe(0);
    expect(daylightProgress(times.sunset, times)).toBe(1);
    expect(daylightProgress(times.sunrise - 3_600_000, times)).toBe(0);
    expect(daylightProgress(times.sunset + 3_600_000, times)).toBe(1);
    const middle = daylightProgress((times.sunrise + times.sunset) / 2, times);
    expect(middle).toBeGreaterThan(0.45);
    expect(middle).toBeLessThan(0.55);
  });
});
