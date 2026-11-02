/**
 * What to sow next, from the farmer's current crop and the calendar.
 *
 * This is deliberately *not* the next-crop engine the plan describes. That one
 * needs district area and production history, mandi price history and input
 * costs, and it ranks crops by an estimated margin. None of those are in the app
 * yet, so a card claiming "plant this, it earns more" would be a number with
 * nothing behind it.
 *
 * What *is* known is which season a crop belongs to and that a crop should not
 * follow itself. Both are ordinary Punjab agronomy, both are checkable, and
 * together they answer the farmer's actual question — "what goes in the field
 * after this one?" — without inventing a rupee figure.
 *
 * The rotation rule is the one worth stating plainly: a crop from another family
 * breaks the pest, disease and nutrient cycle that a crop following itself feeds.
 * A pulse does more — it puts nitrogen back — so it ranks first after a cereal or
 * a fibre crop, which is the cotton-then-wheat pattern this division already
 * runs.
 */

import type { MessageKey } from '@/i18n/catalog';
import { REPORTABLE_CROPS } from './report';

export type Season = 'rabi' | 'kharif';

/**
 * Sowing windows, in months, 0-based and inclusive.
 *
 * Rabi is sown from October and Kharif from April. These are windows for
 * *sowing*, not for harvest, and they are the widest honest statement that can be
 * made without a district-specific calendar — an agronomist can narrow these
 * later without changing anything else.
 */
const WINDOW: Record<Season, { opens: number; closes: number }> = {
  rabi: { opens: 9, closes: 11 },
  kharif: { opens: 3, closes: 6 },
};

/** The catalogued crops of each season, most-sown first. */
export const SEASON_CROPS: Record<Season, readonly string[]> = {
  rabi: ['wheat', 'gram', 'mustard', 'potato', 'onion'],
  kharif: ['cotton', 'rice', 'maize', 'mungbean', 'sugarcane'],
};

/**
 * Crop families, for the rotation rule.
 *
 * Only the crops this app can name are here. A crop the app cannot name has no
 * family, and is therefore never excluded from a rotation — refusing to suggest
 * something it does not understand is better than suggesting it wrongly.
 */
const FAMILY: Record<string, string> = {
  cotton: 'fibre',
  wheat: 'cereal',
  rice: 'cereal',
  maize: 'cereal',
  gram: 'pulse',
  mungbean: 'pulse',
  mustard: 'oilseed',
  potato: 'tuber',
  onion: 'bulb',
  sugarcane: 'cash',
};

/** Pulses put nitrogen back, so they rank first after anything else. */
const NITROGEN_FIXING = new Set(['gram', 'mungbean']);

export const SEASON_KEYS: Record<Season, MessageKey> = {
  rabi: 'home.nextCrop.season.rabi',
  kharif: 'home.nextCrop.season.kharif',
};

/** The crop code behind a catalogue key, or null when the app cannot name it. */
export function cropCodeOf(nameKey: string | null | undefined): string | null {
  if (!nameKey) return null;
  return REPORTABLE_CROPS.find((crop) => crop.nameKey === nameKey)?.code ?? null;
}

export function cropNameKey(code: string): MessageKey | null {
  return REPORTABLE_CROPS.find((crop) => crop.code === code)?.nameKey ?? null;
}

/** The season whose sowing window contains a month, or null between windows. */
export function seasonOfSowingMonth(month: number): Season | null {
  if (month >= WINDOW.rabi.opens && month <= WINDOW.rabi.closes) return 'rabi';
  if (month >= WINDOW.kharif.opens && month <= WINDOW.kharif.closes) return 'kharif';
  return null;
}

/**
 * When a season's sowing opens and closes. Both roll into next year once they are
 * behind us, so the answer is always the next occurrence rather than a date in
 * the past.
 */
export function sowingWindow(season: Season, now: number): { opensOn: number; closesOn: number } {
  const { opens, closes } = WINDOW[season];
  const year = new Date(now).getFullYear();
  const start = new Date(year, opens, 1).getTime();
  const chosen = start > now ? year : year + 1;
  return {
    opensOn: new Date(chosen, opens, 1).getTime(),
    closesOn: new Date(chosen, closes + 1, 0, 23, 59, 59).getTime(),
  };
}

/** The next season to be sown in, whether its window is open or not. */
export function nextSeason(now: number): { season: Season; open: boolean } {
  const month = new Date(now).getMonth();
  const open = seasonOfSowingMonth(month);
  if (open) return { season: open, open: true };
  const rabi = sowingWindow('rabi', now).opensOn;
  const kharif = sowingWindow('kharif', now).opensOn;
  return { season: kharif < rabi ? 'kharif' : 'rabi', open: false };
}

export type NextCropOption = {
  code: string;
  nameKey: MessageKey;
};

export type NextCropAdvice = {
  season: Season;
  /** True while the sowing window is open, false between windows. */
  open: boolean;
  opensOn: number;
  options: NextCropOption[];
};

/**
 * The crops worth sowing next, best first.
 *
 * Ordered by what the rotation does for the field: a pulse first, then any crop
 * from another family, then the rest. The farmer's current crop is never offered,
 * and neither is anything in its family, because a crop following itself is the
 * thing rotation exists to avoid.
 */
export function nextCropAdvice({
  currentCode,
  now,
  limit = 3,
}: {
  currentCode: string | null;
  now: number;
  limit?: number;
}): NextCropAdvice {
  const { season, open } = nextSeason(now);
  const { opensOn } = sowingWindow(season, now);
  const currentFamily = currentCode ? FAMILY[currentCode] : undefined;

  const ranked = SEASON_CROPS[season]
    .filter((code) => code !== currentCode)
    .filter((code) => currentFamily === undefined || FAMILY[code] !== currentFamily)
    .map((code, index) => ({
      code,
      index,
      rank: NITROGEN_FIXING.has(code) ? 0 : 1,
    }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, Math.max(0, limit));

  const options: NextCropOption[] = [];
  for (const entry of ranked) {
    const nameKey = cropNameKey(entry.code);
    if (!nameKey) continue;
    options.push({ code: entry.code, nameKey });
  }

  return { season, open, opensOn, options };
}
