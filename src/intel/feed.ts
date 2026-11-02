import type { MessageKey } from '@/i18n/catalog';
import { validateRadiusM } from './geo';

/**
 * The Home watch feed's verified-source cards.
 *
 * Community chatter is deliberately not an input here: every card below is
 * traceable to an official advisory or a published extension bulletin, and the
 * feed says so on the row. Farmer discussion lives in the Community tab, where
 * it is labelled as discussion — it is never laundered into intelligence.
 *
 * Point-based field reports will filter by the selected radius through
 * `validateRadiusM` once the `intel_feed` backend serves them; until then the
 * feed is regional guidance plus an honest empty note, never invented reports.
 */

export type IntelEvidence = 'official_advisory' | 'expert_verified' | 'forecast_risk';

export type IntelCard = {
  id: 'punjab-advisory' | 'cotton-bollworm-watch';
  topic: 'advisory' | 'pest';
  titleKey: MessageKey;
  bodyKey: MessageKey;
  sourceKey: MessageKey;
  evidence: IntelEvidence;
  /** The upstream portal, when the card points at one. */
  sourceUrl: string | null;
  createdAt: number;
};

/** Radius options in metres: 8, 10, 100 and 500 km, per the product brief. */
export const INTEL_RADIUS_OPTIONS_M: readonly number[] = [8_000, 10_000, 100_000, 500_000];

export const DEFAULT_INTEL_RADIUS_M = 10_000;

export const PUNJAB_ADVISORY_URL = 'https://agripunjab.gov.pk/crop_advisory';

/**
 * Regional guidance cards for the farmer's crop. Pure: same input, same cards,
 * with `createdAt` pinned to `now` so freshness is explicit, not implied.
 */
export function buildIntelCards({
  cropNameKey,
  now,
}: {
  cropNameKey: string | null;
  now: number;
}): IntelCard[] {
  const cards: IntelCard[] = [
    {
      id: 'punjab-advisory',
      topic: 'advisory',
      titleKey: 'intel.advisory.punjab.title',
      bodyKey: 'intel.advisory.punjab.body',
      sourceKey: 'intel.source.official',
      evidence: 'official_advisory',
      sourceUrl: PUNJAB_ADVISORY_URL,
      createdAt: now,
    },
  ];
  // Seasonal vigilance from the published extension bulletin behind the
  // cotton knowledge entries — a watch instruction, never an outbreak claim.
  if (cropNameKey === 'crop.cotton') {
    cards.push({
      id: 'cotton-bollworm-watch',
      topic: 'pest',
      titleKey: 'intel.watch.bollworm.title',
      bodyKey: 'intel.watch.bollworm.body',
      sourceKey: 'intel.source.knowledge',
      evidence: 'expert_verified',
      sourceUrl: null,
      createdAt: now,
    });
  }
  return cards;
}

/** Guard the radius before it drives any geographic filtering. */
export function checkIntelRadius(radiusM: number): void {
  validateRadiusM(radiusM);
}
