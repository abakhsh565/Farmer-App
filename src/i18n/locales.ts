/**
 * Locale registry.
 *
 * The PRD names five regional languages plus English, and requires proper RTL
 * behaviour without duplicating logic for it. Both of those are structural, so
 * they live here rather than in the screens:
 *
 *  · Direction is a property of the locale, declared once. Nothing downstream
 *    asks "is this Urdu?" — components use logical properties and a single
 *    `dir` attribute on <html>, so a new RTL language mirrors correctly the day
 *    it is registered, with no component touched.
 *
 *  · Every locale declares a fallback chain that terminates in English. That is
 *    the guarantee that matters for a half-translated release: a missing string
 *    degrades to a language the farmer's neighbour can read, and never to a raw
 *    key like `credit.counteroffer.title` sitting in the middle of a sentence.
 *
 * Translation status is recorded per locale and reported by the coverage test,
 * because "we support Punjabi" is a claim that needs a number attached to it.
 */

export type Locale = 'en' | 'ur' | 'pa' | 'sk' | 'sd' | 'ps';

export type TranslationStatus =
  /** Every message key has a reviewed string. */
  | 'complete'
  /** Framework active, strings authored, awaiting fluent-speaker review. */
  | 'partial_pending_review'
  /** Registered so direction and fallback are correct, but barely populated. */
  | 'scaffold';

export type LocaleMeta = {
  code: Locale;
  /** BCP 47 tag, used for Intl formatting. */
  tag: string;
  /** Name in English, for a settings list read by an English speaker. */
  englishName: string;
  /** Name in the language itself, which is what the language picker must show. */
  nativeName: string;
  dir: 'ltr' | 'rtl';
  /** Script, recorded because Punjabi is Shahmukhi here, not Gurmukhi. */
  script: string;
  translationStatus: TranslationStatus;
  /**
   * Resolution order when a key is absent. Always ends at 'en'.
   *
   * Urdu is the fallback for the other regional languages rather than English,
   * because the PRD makes Urdu the default and it is the language most Punjab
   * farmers read. English remains the final backstop.
   */
  fallback: readonly Locale[];
};

export const LOCALE_REGISTRY: Record<Locale, LocaleMeta> = {
  en: {
    code: 'en',
    tag: 'en-PK',
    englishName: 'English',
    nativeName: 'English',
    dir: 'ltr',
    script: 'Latin',
    translationStatus: 'complete',
    fallback: [],
  },
  ur: {
    code: 'ur',
    tag: 'ur-PK',
    englishName: 'Urdu',
    nativeName: 'اردو',
    dir: 'rtl',
    script: 'Nastaliq',
    translationStatus: 'complete',
    fallback: ['en'],
  },
  // Punjabi in Pakistan is written in Shahmukhi, an Arabic-derived script — not
  // Gurmukhi, which is the Indian convention. Getting this wrong would be a
  // straightforwardly wrong product, so the script is recorded explicitly.
  pa: {
    code: 'pa',
    tag: 'pa-Arab-PK',
    englishName: 'Punjabi',
    nativeName: 'پنجابی',
    dir: 'rtl',
    script: 'Shahmukhi',
    translationStatus: 'scaffold',
    fallback: ['ur', 'en'],
  },
  sk: {
    code: 'sk',
    tag: 'sk-PK',
    englishName: 'Saraiki',
    nativeName: 'سرائیکی',
    dir: 'rtl',
    script: 'Shahmukhi (Saraiki orthography)',
    translationStatus: 'scaffold',
    fallback: ['ur', 'en'],
  },
  sd: {
    code: 'sd',
    tag: 'sd-PK',
    englishName: 'Sindhi',
    nativeName: 'سنڌي',
    dir: 'rtl',
    script: 'Arabic (Sindhi orthography)',
    translationStatus: 'scaffold',
    fallback: ['ur', 'en'],
  },
  ps: {
    code: 'ps',
    tag: 'ps-PK',
    englishName: 'Pashto',
    nativeName: 'پښتو',
    dir: 'rtl',
    script: 'Arabic (Pashto orthography)',
    translationStatus: 'scaffold',
    fallback: ['ur', 'en'],
  },
};

/** Stable display order: the two complete locales first, then the scaffolds. */
export const LOCALES: readonly Locale[] = ['en', 'ur', 'pa', 'sk', 'sd', 'ps'];

export const RTL_LOCALES: readonly Locale[] = LOCALES.filter(
  (code) => LOCALE_REGISTRY[code].dir === 'rtl',
);

export function isRtl(locale: Locale): boolean {
  return LOCALE_REGISTRY[locale].dir === 'rtl';
}

export function isLocale(value: string): value is Locale {
  return Object.prototype.hasOwnProperty.call(LOCALE_REGISTRY, value);
}

/**
 * The full resolution order for a locale: itself, then its declared fallbacks.
 *
 * Exported and tested because the "never show a raw key" guarantee depends on
 * this list ending at a locale with complete coverage, and a future edit to a
 * fallback chain could quietly break that.
 */
export function resolveLocaleChain(locale: Locale): Locale[] {
  const chain: Locale[] = [];
  const seen = new Set<Locale>();

  const walk = (code: Locale) => {
    if (seen.has(code)) return; // a cycle would otherwise hang the render
    seen.add(code);
    chain.push(code);
    for (const next of LOCALE_REGISTRY[code].fallback) walk(next);
  };

  walk(locale);
  return chain;
}
