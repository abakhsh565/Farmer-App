/**
 * The one adapter between the interest-settings RPCs and the settings screen.
 *
 * The server owns weights, provenance and pin state. This module only validates
 * that contract, preserves the server's order, and turns a topic slug into words
 * a farmer can read. It never calculates, ranks or adjusts a weight.
 */

import type { MessageKey } from '@/i18n/catalog';

export type InterestSource = 'explicit' | 'behaviour' | 'feedback' | 'system';

export type InterestSetting = {
  topic: string;
  cropCode: string | null;
  weight: number;
  confidence: number;
  source: InterestSource;
  pinned: boolean;
  updatedAt: string | null;
};

const SOURCES: readonly InterestSource[] = ['explicit', 'behaviour', 'feedback', 'system'];
const TOPIC_PATTERN = /^[a-z]+:[a-z0-9_-]{1,60}$/;
const MAX_INTERESTS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Validates one row; a row without a usable topic or weight is not rendered. */
export function parseInterestSetting(input: unknown): InterestSetting | null {
  if (!isRecord(input)) return null;

  const topic = typeof input.topic === 'string' ? input.topic : '';
  if (!TOPIC_PATTERN.test(topic)) return null;

  if (typeof input.weight !== 'number' || !Number.isFinite(input.weight)) return null;

  const source =
    typeof input.source === 'string' && SOURCES.includes(input.source as InterestSource)
      ? (input.source as InterestSource)
      : 'behaviour';

  return {
    topic,
    cropCode:
      typeof input.cropCode === 'string'
        ? input.cropCode
        : typeof input.crop_code === 'string'
          ? input.crop_code
          : null,
    weight: input.weight,
    confidence: numberOr(input.confidence, 0),
    source,
    pinned: input.pinned === true,
    updatedAt:
      typeof input.updatedAt === 'string'
        ? input.updatedAt
        : typeof input.updated_at === 'string'
          ? input.updated_at
          : null,
  };
}

/** Validates a list, drops malformed/duplicate topics, and keeps server order. */
export function parseInterestSettings(input: unknown): InterestSetting[] {
  if (!Array.isArray(input)) return [];

  const seen = new Set<string>();
  const out: InterestSetting[] = [];

  for (const raw of input) {
    if (out.length >= MAX_INTERESTS) break;
    const row = parseInterestSetting(raw);
    if (!row || seen.has(row.topic)) continue;
    seen.add(row.topic);
    out.push(row);
  }

  return out;
}

export type InterestGroups = {
  pinned: InterestSetting[];
  chosen: InterestSetting[];
  learned: InterestSetting[];
};

/**
 * Three groups, in the order a farmer should read them: what they have kept,
 * what they chose, then what the app noticed. Server order is preserved inside
 * each group; an explicit unpinned interest stays "chosen" even while its weight
 * learns again.
 */
export function groupInterestSettings(settings: readonly InterestSetting[]): InterestGroups {
  const pinned: InterestSetting[] = [];
  const chosen: InterestSetting[] = [];
  const learned: InterestSetting[] = [];

  for (const row of settings) {
    if (row.pinned) pinned.push(row);
    else if (row.source === 'explicit') chosen.push(row);
    else learned.push(row);
  }

  return { pinned, chosen, learned };
}

const TOPIC_LABELS: Record<string, MessageKey> = {
  'topic:pest': 'interests.topic.pest',
  'topic:weather': 'interests.topic.weather',
  'topic:activity': 'interests.topic.activity',
  'topic:market': 'interests.topic.market',
  'topic:general': 'interests.topic.general',
  'topic:agronomy': 'interests.topic.agronomy',
  'topic:irrigation': 'interests.topic.irrigation',
  'topic:nutrition': 'interests.topic.nutrition',
  'topic:safety': 'interests.topic.safety',
  'topic:disease': 'interests.topic.disease',
  'crop:cotton': 'crop.cotton',
  'crop:wheat': 'crop.wheat',
  'crop:maize': 'crop.maize',
  'crop:rice': 'crop.rice',
};

/**
 * A readable label for a namespaced topic. Known agricultural topics use the
 * reviewed catalog; anything else is shown as the farmer's own subject with the
 * namespace removed — never as a raw `topic:...` slug, and never as a new
 * category invented by the UI.
 */
export function interestLabel(
  topic: string,
  t: (key: MessageKey) => string,
): string {
  const known = TOPIC_LABELS[topic];
  if (known) return t(known);

  const slug = topic.includes(':') ? topic.slice(topic.indexOf(':') + 1) : topic;
  const words = slug.replace(/[-_]+/g, ' ').trim();
  if (words.length === 0) return topic;
  return words.replace(/\b\w/g, (character) => character.toUpperCase());
}

/** The short provenance line shown beside a row. */
export function interestSourceKey(row: InterestSetting): MessageKey {
  if (row.pinned) return 'interests.source.pinned';
  if (row.source === 'explicit') return 'interests.source.explicit';
  return 'interests.source.learned';
}
