import type { Body } from '@/data/community';
import {
  ALLOWED_MEDIA_PREFIXES,
  ATTACHMENT_MAX_BYTES,
  BLOCKED_TERMS,
  DUPLICATE_LOOKBACK,
  RATE_LIMIT_COUNT,
  RATE_LIMIT_WINDOW_MS,
} from '@/data/community-rules';
import type { MessageKey } from '@/i18n/catalog';

/**
 * Every rule that decides whether something may be published, as pure functions.
 *
 * They return a **message key**, not a sentence: the rules belong to the product
 * and the words belong to the catalog, and a farmer reading in Urdu must be told
 * which rule they broke in Urdu. They are also pure, which is what makes the
 * moderation rules testable without a browser: `validate.test.ts` runs the same
 * functions the composer does.
 *
 * Nothing here talks to a network or to storage. A rule that cannot be checked on
 * the device is a rule this release does not have (see `docs/COMMUNITY.md`).
 */

/** Case and whitespace are noise at this boundary: "Sabzi " and "sabzi" are one word. */
function normalise(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * A term the rules do not allow, or null. Substring matching on purpose: the
 * abusive word is usually inside a longer line, and a word-boundary match misses
 * "stupidest" and every Urdu compound.
 */
export function findBlockedTerm(text: string): string | null {
  const haystack = normalise(text);
  return BLOCKED_TERMS.find((term) => haystack.includes(normalise(term))) ?? null;
}

export function isEmpty(text: string): boolean {
  return text.trim().length === 0;
}

export function isTooLong(text: string, max: number): boolean {
  return text.trim().length > max;
}

/**
 * An attachment the device will accept. Type and size only — whether the file is
 * actually readable is the browser's business, and it says so itself.
 */
export function checkAttachment(file: { type: string; size: number }): MessageKey | null {
  if (!ALLOWED_MEDIA_PREFIXES.some((prefix) => file.type.startsWith(prefix))) {
    return 'community.error.fileType';
  }
  if (file.size > ATTACHMENT_MAX_BYTES) {
    return 'community.error.fileSize';
  }
  return null;
}

export type Entryish = { body: Body; createdAt: number };

/**
 * The whole check for one post, reply or story, in the order the messages should
 * be shown: what the farmer wrote, then whether it is allowed, then whether they
 * are posting too fast. The rate limit is last because it is the only one of the
 * four that is not about the text in front of them.
 *
 * `mine` is this farmer's own recent entries — the duplicate and rate checks are
 * about their own behaviour, not the feed's.
 */
export function checkEntry({
  text,
  body,
  max,
  mine,
  now,
}: {
  text: string;
  /** The same text as a `Body`, when it is already one (drafts are plain strings). */
  body?: Body | null;
  max: number;
  mine: readonly Entryish[];
  now: number;
}): MessageKey | null {
  if (isEmpty(text)) return 'community.error.empty';
  if (isTooLong(text, max)) return 'community.error.long';
  if (findBlockedTerm(text)) return 'community.error.rules';

  const recent = [...mine].sort((a, b) => b.createdAt - a.createdAt);

  const candidate = body ?? { text };
  const duplicate = recent.slice(0, DUPLICATE_LOOKBACK).some((entry) => sameBody(entry.body, candidate));
  if (duplicate) return 'community.error.duplicate';

  const inWindow = mine.filter((entry) => now - entry.createdAt < RATE_LIMIT_WINDOW_MS);
  if (inWindow.length >= RATE_LIMIT_COUNT) return 'community.error.tooFast';

  return null;
}

/** Two bodies carry the same words — whether they are keys or typed text. */
export function sameBody(a: Body, b: Body): boolean {
  if ('key' in a && 'key' in b) return a.key === b.key;
  if ('text' in a && 'text' in b) return normalise(a.text) === normalise(b.text);
  return false;
}
