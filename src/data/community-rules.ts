import type { MessageKey } from '@/i18n/catalog';

/**
 * The rules of the Community feed, in one file, because they are the part of this
 * feature that somebody will want to change without reading a component.
 *
 * Three things live here and nowhere else:
 *
 *   1. **The limits** — how long a post may be, how big an attachment may be, how
 *      fast a farmer may post. They are enforced in `src/community/validate.ts`,
 *      which is a pure function, so a change here is a change to the behaviour and
 *      to the tests at the same time.
 *   2. **What is not allowed** — the term filter and the reasons a farmer can
 *      report something with.
 *   3. **What the farmer is told** — the guidelines, the ladder of consequences
 *      and the terms. They are message keys, so the rules read in Urdu as well as
 *      in English, and rewriting a rule means editing two strings and nothing else.
 *
 * These are the values for a first release on one phone with no server. The
 * moderation ladder and the term list are deliberately the parts most likely to
 * be replaced by a real service, and they are isolated here so that replacing
 * them does not touch the feed.
 */

// ── what is allowed through the composer ────────────────────────────────────

/** A question long enough to describe a crop problem, short enough to read. */
export const POST_MAX = 500;
export const COMMENT_MAX = 300;
/** A story is a sentence over a photo, not a post. */
export const STORY_MAX = 150;

/**
 * Attachments are held as `blob:` object URLs, which live in memory and die with
 * the page — see `community.terms.4`. The size cap is what keeps a farmer's phone
 * from running out of memory holding a video it cannot upload anyway.
 */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ALLOWED_MEDIA_PREFIXES: readonly string[] = ['image/', 'video/'];

/** A voice message is a sentence or two, not a lecture — recording stops itself. */
export const VOICE_MAX_MS = 60_000;

/**
 * Posting speed. This is a spam guard, not a ration: a farmer who has answered
 * three questions in a row is fine, and one who has sent six lines in a minute is
 * not reading anything.
 */
export const RATE_LIMIT_COUNT = 5;
export const RATE_LIMIT_WINDOW_MS = 60_000;

/** How far back the duplicate check looks through your own posts and replies. */
export const DUPLICATE_LOOKBACK = 3;

/**
 * The term filter. Kept short and mild on purpose: this file is read by whoever
 * reviews the rules, and a list of slurs is not something to leave lying in a
 * repository. What it does catch is the two things that actually ruin a farming
 * feed — abuse, and the scam replies that follow every question about a subsidy.
 *
 * Matching is case-insensitive and substring, in all three scripts people here
 * write in. A false positive is recoverable (the farmer rewords it and is told
 * why); a false negative costs somebody a season's savings.
 */
export const BLOCKED_TERMS: readonly string[] = [
  // Abuse.
  'bewakoof',
  'بیوقوف',
  'idiot',
  'stupid',
  'احمق',
  'jahil',
  'جاہل',
  // Spam and the fraud patterns seen under subsidy questions.
  'free paisa',
  'click here',
  'lottery',
  'loan approved',
  'whatsapp par rabta',
  'واٹس ایپ پر رابطہ',
];

// ── reporting ───────────────────────────────────────────────────────────────

export type ReportReasonId = 'spam' | 'abuse' | 'falseAdvice' | 'offTopic' | 'other';

/**
 * The reasons are offered rather than left to a free-text box, and the middle one
 * is the reason this feature exists at all: advice that damages a crop is not
 * rude and not off-topic, and a feed that can only report those two will keep it.
 */
export const REPORT_REASONS: ReadonlyArray<{ id: ReportReasonId; labelKey: MessageKey }> = [
  { id: 'falseAdvice', labelKey: 'community.report.reason.falseAdvice' },
  { id: 'abuse', labelKey: 'community.report.reason.abuse' },
  { id: 'spam', labelKey: 'community.report.reason.spam' },
  { id: 'offTopic', labelKey: 'community.report.reason.offTopic' },
  { id: 'other', labelKey: 'community.report.reason.other' },
];

// ── what the farmer is told ─────────────────────────────────────────────────

/** Shown on the rules screen, in this order. Adding a rule is adding one row. */
export const RULES: ReadonlyArray<{ id: string; titleKey: MessageKey; bodyKey: MessageKey }> = [
  { id: 'topic', titleKey: 'community.rules.1.title', bodyKey: 'community.rules.1.body' },
  { id: 'clarity', titleKey: 'community.rules.2.title', bodyKey: 'community.rules.2.body' },
  { id: 'honesty', titleKey: 'community.rules.3.title', bodyKey: 'community.rules.3.body' },
  { id: 'respect', titleKey: 'community.rules.4.title', bodyKey: 'community.rules.4.body' },
  { id: 'spam', titleKey: 'community.rules.5.title', bodyKey: 'community.rules.5.body' },
  { id: 'privacy', titleKey: 'community.rules.6.title', bodyKey: 'community.rules.6.body' },
];

/** What actually happens when a rule is broken — the part a rule is worth without. */
export const ENFORCEMENT: readonly MessageKey[] = [
  'community.enforce.1',
  'community.enforce.2',
  'community.enforce.3',
];

export const TERMS: readonly MessageKey[] = [
  'community.terms.1',
  'community.terms.2',
  'community.terms.3',
  'community.terms.4',
];

/** The tips shown while composing a question. Education, not enforcement. */
export const ASK_TIPS: readonly MessageKey[] = [
  'community.tip.1',
  'community.tip.2',
  'community.tip.3',
];
