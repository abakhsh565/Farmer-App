import { describe, expect, it } from 'vitest';
import { catalogs, en, resolveMessage, translationCoverage, type MessageKey } from './catalog';
import { LOCALES, LOCALE_REGISTRY, RTL_LOCALES, isLocale, resolveLocaleChain } from './locales';

const ALL_KEYS = Object.keys(en) as MessageKey[];

describe('locale registry', () => {
  it('keeps en and ur complete, so the parity type stays meaningful', () => {
    expect(Object.keys(catalogs.en)).toHaveLength(ALL_KEYS.length);
    expect(Object.keys(catalogs.ur)).toHaveLength(ALL_KEYS.length);
    expect(translationCoverage('en')).toBe(1);
    expect(translationCoverage('ur')).toBe(1);
  });

  it('marks the regional locales as not yet fully translated', () => {
    // This is an honesty assertion, not a wish. If someone machine-translates
    // the catalogue and forgets to update the registry status, this fails and
    // forces the claim to be re-examined rather than silently overstated.
    for (const locale of ['pa', 'sk', 'sd', 'ps'] as const) {
      expect(LOCALE_REGISTRY[locale].translationStatus).not.toBe('complete');
      const coverage = translationCoverage(locale);
      expect(coverage).toBeGreaterThan(0);
      expect(coverage).toBeLessThan(1);
    }
  });

  it('gives every locale a unique BCP 47 tag', () => {
    const tags = LOCALES.map((code) => LOCALE_REGISTRY[code].tag);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('treats every locale except English as right to left', () => {
    expect(RTL_LOCALES).toEqual(['ur', 'pa', 'sk', 'sd', 'ps']);
    expect(LOCALE_REGISTRY.en.dir).toBe('ltr');
  });

  it('writes Punjabi in Shahmukhi, not Gurmukhi', () => {
    // Punjab is split; the Pakistani product reads Shahmukhi. Recorded as a test
    // because a silent change to the tag would change which script the app
    // renders, and that is a product decision rather than a detail.
    expect(LOCALE_REGISTRY.pa.tag).toBe('pa-Arab-PK');
    expect(LOCALE_REGISTRY.pa.script).toBe('Shahmukhi');
  });
});

describe('fallback resolution', () => {
  it('terminates every chain at English', () => {
    for (const locale of LOCALES) {
      const chain = resolveLocaleChain(locale);
      expect(chain[chain.length - 1]).toBe('en');
      expect(new Set(chain).size).toBe(chain.length);
    }
  });

  it('never renders a raw message key for any locale', () => {
    // The guarantee that makes a scaffolded locale shippable. Without it, a
    // farmer on Punjabi would read `nav.scanAria` in the middle of the app.
    for (const locale of LOCALES) {
      for (const key of ALL_KEYS) {
        const value = resolveMessage(locale, key);
        expect(value, `${locale} / ${key}`).toBeTruthy();
        expect(value, `${locale} / ${key}`).not.toBe(key);
      }
    }
  });

  it('prefers the regional string, then Urdu, then English', () => {
    // nav.home is present in every regional catalogue.
    expect(resolveMessage('pa', 'nav.home')).toBe(catalogs.pa['nav.home']);
    // A key absent from Punjabi but present in Urdu resolves to Urdu.
    const urduOnly = ALL_KEYS.find(
      (key) => catalogs.pa[key] === undefined && catalogs.ur[key] !== undefined,
    );
    expect(urduOnly).toBeDefined();
    expect(resolveMessage('pa', urduOnly as MessageKey)).toBe(catalogs.ur[urduOnly as MessageKey]);
  });

  it('recognises registered locales and rejects unknown codes', () => {
    expect(isLocale('pa')).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(isLocale('')).toBe(false);
  });

  it('reports measured coverage rather than an assumed one', () => {
    // Printed so the alignment ledger can quote a real number.
    const report = LOCALES.map(
      (code) =>
        `${code}=${(translationCoverage(code) * 100).toFixed(1)}% (${LOCALE_REGISTRY[code].translationStatus})`,
    ).join('  ');
    console.log(`translation coverage — ${report}`);
    expect(report).toContain('en=100.0%');
  });
});
