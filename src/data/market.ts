import type { MessageKey } from '@/i18n/catalog';

/**
 * Mandi rates, as the normalized record the PRD specifies: commodity, market,
 * observation time, unit, reported values, source and ingestion metadata.
 *
 * Two behaviours here are the whole point of the file. A record that is missing
 * stays missing — the UI shows "no rate today" rather than yesterday's number
 * wearing today's label, because inventing a rate is the one thing a market feed
 * must never do. And a record that is present but old is shown *with* its age, so
 * a farmer can see for themselves that the number is three days stale.
 *
 * AMIS Punjab is the accepted initial source; the adapter is this module's shape.
 */

export type MarketRecord = {
  id: string;
  commodityKey: MessageKey;
  marketKey: MessageKey;
  observedAt: number;
  unitKey: MessageKey;
  min: number;
  max: number;
  /** Fair average quality price — the figure the mandi board quotes first. */
  fqp: number;
  sourceKey: MessageKey;
  ingestedAt: number;
};

/** A rate older than a day and a half is shown as stale, never as current. */
export const RATE_MAX_AGE_MS = 36 * 60 * 60 * 1000;

export const RATE_COMMODITIES: ReadonlyArray<MessageKey> = [
  'crop.cotton',
  'crop.wheat',
  'crop.maize',
];

export function rateFor(
  records: readonly MarketRecord[],
  commodityKey: MessageKey,
): MarketRecord | undefined {
  return records.find((record) => record.commodityKey === commodityKey);
}

export function isStale(record: MarketRecord, now: number): boolean {
  return now - record.observedAt > RATE_MAX_AGE_MS;
}

/**
 * The demo's records. Cotton and wheat were reported this morning; maize has no
 * fresh record, and the seed says so honestly instead of borrowing a figure.
 */
export function createRecords(now: number): MarketRecord[] {
  const morning = new Date(now);
  morning.setHours(8, 10, 0, 0);
  const eightTen = morning.getTime();

  return [
    {
      id: 'rate-cotton-1',
      commodityKey: 'crop.cotton',
      marketKey: 'market.wazirabad',
      observedAt: eightTen,
      unitKey: 'rates.unit',
      min: 7_900,
      max: 8_450,
      fqp: 8_200,
      sourceKey: 'source.amis',
      ingestedAt: eightTen + 4 * 60 * 1000,
    },
    {
      id: 'rate-wheat-1',
      commodityKey: 'crop.wheat',
      marketKey: 'market.wazirabad',
      observedAt: eightTen,
      unitKey: 'rates.unit',
      min: 3_850,
      max: 3_950,
      fqp: 3_900,
      sourceKey: 'source.amis',
      ingestedAt: eightTen + 4 * 60 * 1000,
    },
    {
      id: 'rate-maize-1',
      commodityKey: 'crop.maize',
      marketKey: 'market.wazirabad',
      observedAt: now - 3 * 24 * 60 * 60 * 1000,
      unitKey: 'rates.unit',
      min: 2_600,
      max: 2_700,
      fqp: 2_650,
      sourceKey: 'source.amis',
      ingestedAt: now - 3 * 24 * 60 * 60 * 1000 + 4 * 60 * 1000,
    },
  ];
}
