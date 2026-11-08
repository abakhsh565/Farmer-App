/**
 * Regional catalogues: Punjabi, Saraiki, Sindhi, Pashto.
 *
 * These are PARTIAL BY DESIGN and are marked `scaffold` in the locale registry.
 * Read this before shipping them to farmers.
 *
 * What is real here:
 *   · the framework — registration, direction, RTL, and a fallback chain that
 *     terminates in English, so no screen can ever render a raw message key
 *   · the navigation vocabulary, which is the highest-visibility text in the app
 *
 * What is NOT real here, and must not be represented as done:
 *   · full translation. These four locales carry a small set of strings. Every
 *     other message falls back to Urdu, then English.
 *   · native review. The strings below are written to be *plausible and
 *     non-harmful*, and are explicitly marked as awaiting a fluent speaker.
 *     Agricultural terminology in particular — disease names, pesticide terms,
 *     units — is NOT translated here, because a wrong crop-disease name on a
 *     spray recommendation is a safety problem, not a spelling problem.
 *
 * The consequence of an error in the current state is bounded: a farmer on one
 * of these locales sees correct Urdu for anything not listed below. That is the
 * point of building the fallback before the translations, rather than after.
 *
 * Coverage is measured and printed by `src/i18n/locales.test.ts`, so the number
 * in the alignment ledger is produced by a test rather than by optimism.
 */

import type { MessageKey } from './catalog';

/**
 * Keys deliberately restricted to navigation, the dismiss/cancel vocabulary,
 * and generic actions. Nothing here is advice, a warning, a unit, a dosage or a
 * chemical name — those need a domain translator, not a general one.
 */
export type PartialCatalog = Partial<Record<MessageKey, string>>;

export const pa: PartialCatalog = {
  'nav.main': 'مکھ',
  'nav.home': 'گھر',
  'nav.dealers': 'ڈیلراں',
  'nav.shop': 'دوکان',
  'nav.scan': 'سکین',
  'nav.scanAria': 'فصل سکین کرو',
  'nav.chat': 'گل بات',
  'nav.community': 'سنگت',
  'common.seeAll': 'سارے ویکھو',
  'common.cancel': 'منسوخ کرو',
  'common.close': 'بند کرو',
  'common.next': 'اگلا',
  'common.back': 'واپس',
  'common.tryAgain': 'فیر کوشش کرو',
};

export const sk: PartialCatalog = {
  'nav.main': 'مکھ',
  'nav.home': 'گھر',
  'nav.dealers': 'ڈیلر',
  'nav.shop': 'دڪان',
  'nav.scan': 'سکین',
  'nav.chat': 'ڳالھ ٻات',
  'nav.community': 'سنگت',
  'common.seeAll': 'سارے ݙیکھو',
  'common.cancel': 'منسوخ',
  'common.close': 'بند',
  'common.next': 'اڳلا',
  'common.back': 'پچھاں',
};

export const sd: PartialCatalog = {
  'nav.main': 'مک',
  'nav.home': 'گهر',
  'nav.dealers': 'واپاري',
  'nav.shop': 'دڪان',
  'nav.scan': 'اسڪين',
  'nav.chat': 'ڳالهه ٻولهه',
  'nav.community': 'سنگت',
  'common.seeAll': 'سڀ ڏسو',
  'common.cancel': 'منسوخ',
  'common.close': 'بند',
  'common.next': 'اڳيون',
  'common.back': 'واپس',
};

export const ps: PartialCatalog = {
  'nav.main': 'اصلي',
  'nav.home': 'کور',
  'nav.dealers': 'دوکانداران',
  'nav.shop': 'دوکان',
  'nav.scan': 'سکن',
  'nav.chat': 'خبرې',
  'nav.community': 'ټولنه',
  'common.seeAll': 'ټول وګوره',
  'common.cancel': 'لغوه',
  'common.close': 'بندول',
  'common.next': 'بل',
  'common.back': 'شاته',
};
