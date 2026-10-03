import { describe, expect, it } from 'vitest';
import {
  formatDay,
  formatDayParts,
  formatHour,
  formatMoney,
  formatWeekdayDate,
  intlLocale,
} from '@/i18n/format';
import { en as englishCatalog, ur as urduCatalog, type MessageKey } from '@/i18n/catalog';

/** Intl emits non-breaking spaces; normalise so the assertions read as intended. */
const plain = (value: string) => value.replace(/\u00a0/g, ' ');

/**
 * A translate function over just the keys a case needs, interpolating the way
 * LocaleProvider's `t` does — otherwise `{hour} {period}` would never resolve.
 */
const stub =
  (map: Partial<Record<MessageKey, string>>) =>
  (key: MessageKey, values?: Record<string, string | number>) => {
    const template = map[key] ?? key;
    if (!values) return template;
    return template.replace(/\{(\w+)\}/g, (_, name: string) =>
      name in values ? String(values[name]) : `{${name}}`,
    );
  };

describe('format', () => {
  it('quotes rupees in whole units, with the symbol this app writes', () => {
    // Intl's en-PK symbol is "Rs" with no dot, while the design writes "Rs." — so
    // the pattern comes from the catalog and Intl only supplies the digits.
    const moneyEn = stub({ 'money.amount': englishCatalog['money.amount'] });
    const moneyUr = stub({ 'money.amount': urduCatalog['money.amount'] });

    expect(plain(formatMoney(8200, 'en', moneyEn))).toBe('Rs. 8,200');
    // Urdu writes the word after the number rather than a Latin symbol before it.
    expect(plain(formatMoney(8200, 'ur', moneyUr))).toBe('8,200 روپے');
    expect(plain(formatMoney(21_670, 'en', moneyEn))).toContain('21,670');
    expect(englishCatalog['money.amount']).toBe('Rs. {amount}');
  });

  it('writes dates day-first in English and with Urdu month names in Urdu', () => {
    const date = new Date(2026, 9, 4);

    expect(plain(formatDay(date, 'en'))).toBe('4 Oct');
    expect(plain(formatDay(date, 'ur'))).toBe('4 اکتوبر');
  });

  it('splits a date into the two lines a day tile shows', () => {
    const date = new Date(2026, 9, 4);

    expect(formatDayParts(date, 'en')).toEqual({ month: 'Oct', day: '4' });
    expect(formatDayParts(date, 'ur')).toEqual({ month: 'اکتوبر', day: '4' });
  });

  it('labels the weather card with the real date rather than a frozen string', () => {
    // 30 Sep 2026 is a Wednesday; the point is that it follows the calendar.
    expect(plain(formatWeekdayDate(new Date(2026, 8, 30), 'en'))).toContain('30');
    expect(plain(formatWeekdayDate(new Date(2026, 8, 30), 'en'))).toContain('Sept');
    expect(plain(formatWeekdayDate(new Date(2026, 8, 30), 'ur'))).toContain('ستمبر');
  });

  it('writes shop hours the way each language orders them', () => {
    // The period word sits after the number in English and before it in Urdu, so
    // the phrase is a pattern rather than a suffix glued onto "7".
    const en = stub({
      'time.hourPeriod': englishCatalog['time.hourPeriod'],
      'time.am': englishCatalog['time.am'],
      'time.pm': englishCatalog['time.pm'],
    });
    const ur = stub({
      'time.hourPeriod': urduCatalog['time.hourPeriod'],
      'time.am': urduCatalog['time.am'],
      'time.pm': urduCatalog['time.pm'],
    });

    expect(formatHour(19, en)).toBe('7 PM');
    expect(formatHour(8, en)).toBe('8 AM');
    expect(formatHour(19, ur)).toBe('شام 7');
    expect(formatHour(8, ur)).toBe('صبح 8');
    // Capitalised, the way the design's dealer rows and the rate board write it.
    expect(englishCatalog['time.pm']).toBe('PM');
  });

  it('puts midnight and noon on the right side of 12', () => {
    const en = stub({
      'time.hourPeriod': englishCatalog['time.hourPeriod'],
      'time.am': englishCatalog['time.am'],
      'time.pm': englishCatalog['time.pm'],
    });

    expect(formatHour(0, en)).toBe('12 AM');
    expect(formatHour(12, en)).toBe('12 PM');
    expect(formatHour(23, en)).toBe('11 PM');
  });

  it('maps each language to the Intl locale that fits it', () => {
    // en-PK rather than en-US: rupees and day-first dates.
    expect(intlLocale('en')).toBe('en-PK');
    expect(intlLocale('ur')).toBe('ur');
  });
});
