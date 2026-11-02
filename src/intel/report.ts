/**
 * A farmer's field problem, validated the way the database will validate it.
 *
 * The rules below are the SQL's rules, restated where the farmer can be told
 * about them before a round trip: a topic from the closed set, a non-empty title
 * and body, an approximate area, and coordinates that are real. The server
 * re-checks all of it — this is the friendly side of the same wall, not a
 * replacement for it.
 *
 * Two limits are deliberately tighter than the columns: 120 characters of title
 * and 600 of body, against the schema's 200 and 4000. A report is read on a phone
 * by a neighbour, and a form that accepts 4000 characters is how a field report
 * becomes an essay nobody finishes.
 *
 * Coordinates are rounded to two decimals here as well as in the insert function,
 * so the point that leaves the device is already the approximate one — the exact
 * fix never travels, rather than travelling and being rounded on arrival.
 */

import type { MessageKey } from '@/i18n/catalog';

/** The closed set the `crop_reports.topic` check constraint accepts. */
export const REPORT_TOPICS = ['pest', 'disease', 'weed', 'water', 'weather_damage', 'other'] as const;

export type ReportTopic = (typeof REPORT_TOPICS)[number];

export const REPORT_TOPIC_KEYS: Record<ReportTopic, MessageKey> = {
  pest: 'report.topic.pest',
  disease: 'report.topic.disease',
  weed: 'report.topic.weed',
  water: 'report.topic.water',
  weather_damage: 'report.topic.weather_damage',
  other: 'report.topic.other',
};

export const REPORT_TITLE_MAX = 120;
export const REPORT_BODY_MAX = 600;

/**
 * Crops a report may name, and the code each one stores.
 *
 * The codes are `crop_catalog.code` values, so a report carries the same
 * identifier the rest of the backend uses. The list is the catalogued set — not
 * whatever the farmer has planted — because a report can be about a crop the app
 * has never been told about.
 */
export const REPORTABLE_CROPS: readonly { code: string; nameKey: MessageKey }[] = [
  { code: 'cotton', nameKey: 'crop.cotton' },
  { code: 'wheat', nameKey: 'crop.wheat' },
  { code: 'rice', nameKey: 'crop.rice' },
  { code: 'maize', nameKey: 'crop.maize' },
  { code: 'sugarcane', nameKey: 'crop.sugarcane' },
  { code: 'gram', nameKey: 'crop.gram' },
  { code: 'potato', nameKey: 'crop.potato' },
  { code: 'mustard', nameKey: 'crop.mustard' },
  { code: 'mungbean', nameKey: 'crop.mungbean' },
  { code: 'onion', nameKey: 'crop.onion' },
];

export function isReportableCrop(code: string | null): boolean {
  return code !== null && REPORTABLE_CROPS.some((crop) => crop.code === code);
}

export type FieldReportDraft = {
  /** A `crop_catalog` code, or null for "another crop". */
  cropCode: string | null;
  topic: ReportTopic | null;
  title: string;
  body: string;
};

/** Where the report is sent from — already approximate, never an exact fix. */
export type FieldReportOrigin = {
  lat: number;
  lon: number;
  areaLabel: string;
  district: string | null;
};

export type FieldReportValue = {
  cropCode: string | null;
  topic: ReportTopic;
  title: string;
  body: string;
  lat: number;
  lon: number;
  areaLabel: string;
  district: string | null;
  /** What the database dedupes on, so a double tap posts one report. */
  idempotencyKey: string;
};

export type FieldReportCheck =
  | { ok: true; value: FieldReportValue }
  | { ok: false; problem: MessageKey };

/** Rounds to the ~1.1 km cell the insert function stores. */
export function approximate(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * A key that is the same for the same report sent twice, and different for the
 * same problem reported on another day.
 *
 * Derived from the content rather than from a per-mount random value, so it
 * survives the composer being closed and reopened: the farmer who taps Send,
 * sees nothing happen, reopens the box and sends the same words again gets one
 * report — which is what they meant. The UTC day is part of it so that reporting
 * the same thing next week is a second report, because it is.
 */
export function reportIdempotencyKey(
  value: Omit<FieldReportValue, 'idempotencyKey'>,
  now: number,
): string {
  const day = new Date(now).toISOString().slice(0, 10);
  const seed = [
    value.cropCode ?? 'none',
    value.topic,
    value.title,
    value.body,
    value.lat.toFixed(2),
    value.lon.toFixed(2),
    day,
  ].join('|');
  return `fr-${fnv1a(seed)}-${day.replace(/-/g, '')}`;
}

/** FNV-1a, base 36. Not a security hash — a stable one, which is all this needs. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Validates and normalises a draft. Order matters: the first thing the farmer can
 * fix is the first thing reported, so the form never says "add a title" about a
 * box they have not reached yet.
 */
export function validateFieldReport(
  draft: FieldReportDraft,
  origin: FieldReportOrigin,
  now: number = Date.now(),
): FieldReportCheck {
  const title = draft.title.trim();
  const body = draft.body.trim();
  const areaLabel = origin.areaLabel.trim();

  if (draft.cropCode !== null && !isReportableCrop(draft.cropCode)) {
    return { ok: false, problem: 'report.error.crop' };
  }
  if (draft.topic === null || !REPORT_TOPICS.includes(draft.topic)) {
    return { ok: false, problem: 'report.error.topic' };
  }
  if (title === '') return { ok: false, problem: 'report.error.emptyTitle' };
  if (title.length > REPORT_TITLE_MAX) return { ok: false, problem: 'report.error.longTitle' };
  if (body === '') return { ok: false, problem: 'report.error.emptyBody' };
  if (body.length > REPORT_BODY_MAX) return { ok: false, problem: 'report.error.longBody' };
  if (areaLabel === '') return { ok: false, problem: 'report.error.area' };
  if (
    !Number.isFinite(origin.lat) ||
    !Number.isFinite(origin.lon) ||
    origin.lat < -90 ||
    origin.lat > 90 ||
    origin.lon < -180 ||
    origin.lon > 180
  ) {
    return { ok: false, problem: 'report.error.area' };
  }

  const normalised = {
    cropCode: draft.cropCode,
    topic: draft.topic,
    title,
    body,
    lat: approximate(origin.lat),
    lon: approximate(origin.lon),
    areaLabel,
    district: origin.district?.trim() || null,
  };

  return { ok: true, value: { ...normalised, idempotencyKey: reportIdempotencyKey(normalised, now) } };
}
