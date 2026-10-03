import type { Locale, MessageKey } from './catalog';
import { LOCALES, LOCALE_REGISTRY } from './locales';

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

/**
 * The one place a number or a date becomes characters.
 *
 * Both used to be typed into the catalog as finished text — `'credit.amount':
 * 'Rs. 3,330'`, `'weather.today': 'Today · Sun 27 Sep'`. That reads fine until
 * you check it: the amount cannot follow the language, and the date was frozen at
 * whatever day it was written, so the weather block claimed a date three days out
 * of step with the spray calendar directly beneath it.
 *
 * The split is: the catalog owns **words and word order**, Intl owns **digits,
 * dates and currency**.
 *
 * `en` maps to `en-PK`, not `en-US`. Rates are quoted in rupees and dates are
 * written day-first in Pakistan, so `4 Oct` — not `Oct 4` — is the correct
 * English here. Urdu resolves to `ur`, which also gives Pakistani month names
 * (`4 اکتوبر`) while keeping Western digits, matching the catalog.
 */
/**
 * Two deliberate deviations from the registry tag.
 *
 * `en` is `en-PK`, not `en-US`: rates are quoted in rupees and dates are written
 * day-first, so `4 Oct` is the correct English here.
 *
 * `ur` is plain `ur`, not the registry's `ur-PK`. ICU renders `ur-PK` with
 * Arabic-Indic digits (۱٬۸۵۰) while the Urdu catalog is authored in Western
 * digits, and mixing the two inside one sentence is what the earlier bug looked
 * like. `ur` keeps the Pakistani month names and the Western digits.
 */
const INTL_OVERRIDES: Partial<Record<Locale, string>> = { en: 'en-PK', ur: 'ur' };

/**
 * Built from the registry rather than hard-coded, so registering a new locale
 * gives it a working number and date format immediately and cannot be forgotten
 * here.
 */
const INTL_LOCALE: Record<Locale, string> = Object.fromEntries(
  LOCALES.map((code) => [code, INTL_OVERRIDES[code] ?? LOCALE_REGISTRY[code].tag]),
) as Record<Locale, string>;

/** The Intl locale behind a UI language, for callers that need it directly. */
export function intlLocale(locale: Locale): string {
  return INTL_LOCALE[locale];
}

/**
 * A bare figure, no currency marker.
 *
 * The rate tiles show `8,200` with `Rs. per 40 kg` once underneath them, which is
 * how a mandi board reads. Same authority as `formatMoney` — only the marker
 * differs — so the digits, grouping and locale still come from one place.
 */
export function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(INTL_LOCALE[locale], { maximumFractionDigits: 0 }).format(value);
}

/**
 * Rupees, in whole units — mandi rates and shop prices are never quoted in paisa.
 *
 * Intl's `en-PK` symbol is "Rs" with no dot, while every mandi board and the rest
 * of this app writes "Rs." — so the pattern comes from the catalog and Intl only
 * supplies the digits and the grouping. It also settles Urdu, where a bare symbol
 * straight out of Intl would drop a Latin "Rs" into Urdu text; "3,330 روپے" is
 * what the language actually writes.
 */
export function formatMoney(value: number, locale: Locale, t: Translate): string {
  return t('money.amount', { amount: formatNumber(value, locale) });
}

/** "4 Oct" / "4 اکتوبر" — a date as one line of text. */
export function formatDay(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    month: 'short',
    day: 'numeric',
  }).format(date);
}

/**
 * The same date split into the two lines a day tile shows: the month above, the
 * day number below.
 */
export function formatDayParts(date: Date, locale: Locale): { month: string; day: string } {
  const parts = new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    month: 'short',
    day: 'numeric',
  }).formatToParts(date);

  return {
    month: parts.find((part) => part.type === 'month')?.value ?? '',
    day: parts.find((part) => part.type === 'day')?.value ?? '',
  };
}

/**
 * A time of day, as shop hours are written: "7 pm" in English, "شام 7" in Urdu.
 *
 * Intl cannot do this one — its Urdu data says "7:00 PM", so the period word has
 * to come from the catalog. The two languages put it on opposite sides of the
 * number, which is why the whole phrase is a pattern rather than a suffix.
 */
export function formatHour(hour24: number, t: Translate): string {
  return t('time.hourPeriod', {
    hour: hour24 % 12 === 0 ? 12 : hour24 % 12,
    period: t(hour24 < 12 ? 'time.am' : 'time.pm'),
  });
}

/**
 * How long ago something happened, the way a feed writes it: "Just now", "4m",
 * "2h", "1d".
 *
 * Both ends are passed in rather than read from the clock, so the caller decides
 * what "now" means — which is what makes this testable and what lets the seeded
 * feed be two hours old at any hour of the day.
 */
export function formatRelativeTime(from: number, to: number, t: Translate): string {
  const minutes = Math.max(0, Math.round((to - from) / 60_000));
  if (minutes < 1) return t('time.justNow');
  if (minutes < 60) return t('time.minutesAgo', { count: minutes });

  // Floored, not rounded: "1h" has to mean "at least an hour", or a post written
  // 95 minutes ago claims two.
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.hoursAgo', { count: hours });

  return t('time.daysAgo', { count: Math.floor(hours / 24) });
}

/** "Wed, 30 Sept" / "بدھ، 30 ستمبر" — the full label on the weather card. */
export function formatWeekdayDate(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(date);
}
