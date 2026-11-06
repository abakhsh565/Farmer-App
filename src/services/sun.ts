/**
 * Sun times, computed rather than fetched.
 *
 * The weather provider answers with temperature, wind, humidity and rain. It does
 * not answer with sunrise or sunset, and the rule this app is built on is that a
 * number on screen is either reported by a source or not shown at all. So the sun
 * arc is not drawn from a guessed 6 AM to 6 PM window: the times behind it are
 * calculated here, from the farmer's own coordinates and the date.
 *
 * The method is NOAA's simplified solar position algorithm, the same one behind
 * most published sunrise tables. It is good to a couple of minutes at Punjab's
 * latitude, which is finer than a farmer needs and far finer than a placeholder.
 *
 * Nothing in this file invents a value. Where the sun does not cross the horizon —
 * a polar day or night — the result is `null` and the screen says nothing about
 * sunrise or sunset, because there is no honest number to print.
 */

/** Local shape rather than a service import: this is arithmetic, not a contract. */
export type SunPoint = { lat: number; lon: number };

export type SunTimes = {
  /** Epoch milliseconds, UTC — format for display at the call site. */
  sunrise: number;
  solarNoon: number;
  sunset: number;
};

const RAD = Math.PI / 180;
const MINUTE = 60_000;
const DAY = 86_400_000;

/** The sun's zenith at sunrise: refraction plus the solar disc's radius. */
const ZENITH_DEGREES = 90.833;

function dayOfYear(date: Date): number {
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 0);
  return Math.floor((date.getTime() - startOfYear) / DAY);
}

/**
 * The three instants the arc needs, or null when the sun does not rise or set.
 *
 * `date` supplies the calendar day (read in UTC, the same clock the provider
 * reports on) and `point` supplies the place. Longitude is east-positive, which
 * is how the app stores it.
 */
export function sunTimes(date: Date, point: SunPoint): SunTimes | null {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return null;

  const n = dayOfYear(date);
  const gamma = ((2 * Math.PI) / 365) * (n - 1 + 0.5);
  const cos = Math.cos;
  const sin = Math.sin;

  /* Equation of time, in minutes: how far the true sun runs from mean solar time. */
  const equationOfTime =
    229.18 *
    (0.000075 +
      0.001868 * cos(gamma) -
      0.032077 * sin(gamma) -
      0.014615 * cos(2 * gamma) -
      0.040849 * sin(2 * gamma));

  /* Solar declination, in radians: how far north or south the sun stands today. */
  const declination =
    0.006918 -
    0.399912 * cos(gamma) +
    0.070257 * sin(gamma) -
    0.006758 * cos(2 * gamma) +
    0.000907 * sin(2 * gamma) -
    0.002697 * cos(3 * gamma) +
    0.00148 * sin(3 * gamma);

  const latitude = point.lat * RAD;
  const cosHourAngle =
    cos(ZENITH_DEGREES * RAD) / (cos(latitude) * cos(declination)) -
    Math.tan(latitude) * Math.tan(declination);

  /* Above 1 the sun never reaches the horizon (polar night); below −1 it never
     leaves it (midnight sun). Neither has a sunrise to quote. */
  if (!Number.isFinite(cosHourAngle) || cosHourAngle > 1 || cosHourAngle < -1) {
    return null;
  }

  const hourAngle = Math.acos(cosHourAngle) / RAD;
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const at = (utcMinutes: number) => midnight + utcMinutes * MINUTE;

  return {
    sunrise: at(720 - 4 * (point.lon + hourAngle) - equationOfTime),
    solarNoon: at(720 - 4 * point.lon - equationOfTime),
    sunset: at(720 - 4 * (point.lon - hourAngle) - equationOfTime),
  };
}

/**
 * How far through the daylight the moment is: 0 at sunrise, 1 at sunset.
 *
 * Outside that window it is clamped rather than extrapolated, so a night reading
 * parks the sun on the horizon instead of drawing it underground.
 */
export function daylightProgress(now: number, times: SunTimes): number {
  const span = times.sunset - times.sunrise;
  if (span <= 0) return 0;
  const fraction = (now - times.sunrise) / span;
  return Math.min(1, Math.max(0, fraction));
}
