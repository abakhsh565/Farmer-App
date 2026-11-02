import { describe, expect, it } from 'vitest';
import {
  REPORT_BODY_MAX,
  REPORT_TITLE_MAX,
  REPORTABLE_CROPS,
  approximate,
  isReportableCrop,
  reportIdempotencyKey,
  validateFieldReport,
  type FieldReportDraft,
  type FieldReportOrigin,
} from './report';

/**
 * What the form refuses, and what it sends.
 *
 * The refusal tests are the point: every one of these would otherwise become a
 * database error the farmer cannot act on, or worse, a stored report that is
 * attributed to a place it did not come from.
 */

const NOW = Date.parse('2026-10-14T09:00:00Z');

const ORIGIN: FieldReportOrigin = {
  lat: 30.96668,
  lon: 70.94123,
  areaLabel: 'Layyah, Chak 42',
  district: 'layyah',
};

const DRAFT: FieldReportDraft = {
  cropCode: 'cotton',
  topic: 'pest',
  title: 'Pink bollworm in bolls',
  body: 'Found larvae in about a tenth of the bolls this morning.',
};

describe('the crops a report can name', () => {
  it('uses the catalog codes the backend already knows', () => {
    expect(REPORTABLE_CROPS.map((crop) => crop.code)).toEqual([
      'cotton',
      'wheat',
      'rice',
      'maize',
      'sugarcane',
      'gram',
      'potato',
      'mustard',
      'mungbean',
      'onion',
    ]);
  });

  it('recognises a catalogued crop and rejects an invented one', () => {
    expect(isReportableCrop('cotton')).toBe(true);
    expect(isReportableCrop('banana')).toBe(false);
    expect(isReportableCrop(null)).toBe(false);
  });
});

describe('a complete report', () => {
  it('passes, normalised', () => {
    const result = validateFieldReport(DRAFT, ORIGIN, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      cropCode: 'cotton',
      topic: 'pest',
      title: 'Pink bollworm in bolls',
      body: 'Found larvae in about a tenth of the bolls this morning.',
      areaLabel: 'Layyah, Chak 42',
      district: 'layyah',
    });
  });

  it('sends an approximate point, never the fix it was given', () => {
    // The exact reading the device produced is 30.96668 / 70.94123. The value that
    // leaves the device is the two-decimal cell, so the farmer's field is not in
    // the payload at all — this is a privacy property, not formatting.
    const result = validateFieldReport(DRAFT, ORIGIN, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lat).toBe(30.97);
    expect(result.value.lon).toBe(70.94);
    expect(approximate(-33.86881)).toBe(-33.87);
  });

  it('accepts "another crop" without inventing a code', () => {
    const result = validateFieldReport({ ...DRAFT, cropCode: null }, ORIGIN, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cropCode).toBeNull();
  });

  it('trims what the farmer typed and keeps the words intact', () => {
    const result = validateFieldReport(
      { ...DRAFT, title: '  Whitefly on the underside  ', body: '  Seen on 6 rows.  ' },
      { ...ORIGIN, areaLabel: '  Layyah, Chak 42  ' },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe('Whitefly on the underside');
    expect(result.value.body).toBe('Seen on 6 rows.');
    expect(result.value.areaLabel).toBe('Layyah, Chak 42');
  });

  it('reports no district when the point is outside the pilot division', () => {
    const result = validateFieldReport(DRAFT, { ...ORIGIN, district: null }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.district).toBeNull();
  });
});

describe('what the form refuses, and why', () => {
  it('asks for a crop only when the crop code is not one the backend has', () => {
    const result = validateFieldReport({ ...DRAFT, cropCode: 'banana' }, ORIGIN, NOW);
    expect(result).toEqual({ ok: false, problem: 'report.error.crop' });
  });

  it('asks for a topic before anything else it can see', () => {
    const result = validateFieldReport({ ...DRAFT, topic: null, title: '' }, ORIGIN, NOW);
    expect(result).toEqual({ ok: false, problem: 'report.error.topic' });
  });

  it('will not store a report with no title or no description', () => {
    expect(validateFieldReport({ ...DRAFT, title: '   ' }, ORIGIN, NOW)).toEqual({
      ok: false,
      problem: 'report.error.emptyTitle',
    });
    expect(validateFieldReport({ ...DRAFT, body: '' }, ORIGIN, NOW)).toEqual({
      ok: false,
      problem: 'report.error.emptyBody',
    });
  });

  it('holds the phone-sized limits, which are tighter than the columns', () => {
    expect(REPORT_TITLE_MAX).toBeLessThan(200);
    expect(REPORT_BODY_MAX).toBeLessThan(4000);
    expect(
      validateFieldReport({ ...DRAFT, title: 'x'.repeat(REPORT_TITLE_MAX + 1) }, ORIGIN, NOW),
    ).toEqual({ ok: false, problem: 'report.error.longTitle' });
    expect(
      validateFieldReport({ ...DRAFT, body: 'x'.repeat(REPORT_BODY_MAX + 1) }, ORIGIN, NOW),
    ).toEqual({ ok: false, problem: 'report.error.longBody' });
    expect(validateFieldReport({ ...DRAFT, title: 'x'.repeat(REPORT_TITLE_MAX) }, ORIGIN, NOW).ok).toBe(
      true,
    );
  });

  it('refuses to report from nowhere, or from a point that is not on Earth', () => {
    expect(validateFieldReport(DRAFT, { ...ORIGIN, areaLabel: '  ' }, NOW)).toEqual({
      ok: false,
      problem: 'report.error.area',
    });
    expect(validateFieldReport(DRAFT, { ...ORIGIN, lat: Number.NaN }, NOW)).toEqual({
      ok: false,
      problem: 'report.error.area',
    });
    expect(validateFieldReport(DRAFT, { ...ORIGIN, lon: 181 }, NOW)).toEqual({
      ok: false,
      problem: 'report.error.area',
    });
  });

  it('leaves the draft it was given untouched', () => {
    const draft: FieldReportDraft = { ...DRAFT, title: '  Spaced  ' };
    validateFieldReport(draft, ORIGIN, NOW);
    expect(draft.title).toBe('  Spaced  ');
  });
});

describe('posting the same report twice', () => {
  const value = {
    cropCode: 'cotton' as string | null,
    topic: 'pest' as const,
    title: 'Pink bollworm in bolls',
    body: 'Found larvae in about a tenth of the bolls this morning.',
    lat: 30.97,
    lon: 70.94,
    areaLabel: 'Layyah, Chak 42',
    district: 'layyah',
  };

  it('derives the same key for the same words, so a double tap is one report', () => {
    const first = validateFieldReport(DRAFT, ORIGIN, NOW);
    const second = validateFieldReport(DRAFT, ORIGIN, NOW + 60_000);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.idempotencyKey).toBe(second.value.idempotencyKey);
  });

  it('derives a different key for a genuine second report the next day', () => {
    const today = reportIdempotencyKey(value, NOW);
    const tomorrow = reportIdempotencyKey(value, NOW + 24 * 60 * 60 * 1000);
    expect(tomorrow).not.toBe(today);
  });

  it('derives a different key when the words or the place differ', () => {
    const base = reportIdempotencyKey(value, NOW);
    expect(reportIdempotencyKey({ ...value, body: 'More larvae today.' }, NOW)).not.toBe(base);
    expect(reportIdempotencyKey({ ...value, lat: 30.98 }, NOW)).not.toBe(base);
    expect(reportIdempotencyKey({ ...value, cropCode: null }, NOW)).not.toBe(base);
  });

  it('produces a key the unique index can hold, with no spaces or punctuation', () => {
    expect(reportIdempotencyKey(value, NOW)).toMatch(/^fr-[a-z0-9]+-\d{8}$/);
  });
});
