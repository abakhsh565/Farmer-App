/**
 * Crop-intelligence geo helpers — pure, deterministic, testable.
 *
 * Mirrors the SQL contract in
 * `supabase/migrations/20261014000000_crop_intelligence.sql` so the radius,
 * dedupe, expiry and privacy rules are provable without a database:
 * radius is metres, it gates eligibility only (never severity), clusters
 * dedupe to verified-then-newest, expired rows are dropped at read time, and
 * no coordinate ever leaves in a feed row.
 */

export const MIN_RADIUS_M = 1;
export const MAX_RADIUS_M = 500_000;

export type Evidence = 'farmer_report' | 'expert_verified' | 'official_advisory' | 'forecast_risk';

export type IntelRow = {
  id: string;
  kind: 'report' | 'advisory';
  title: string;
  cropCode: string | null;
  topic: string | null;
  evidence: Evidence;
  /** Metres from origin for reports; null for district-scope advisories. */
  distanceM: number | null;
  observedAt: number;
  validUntil: number | null;
  clusterId: string | null;
};

/** Radius the feed accepts. Metres, 1..500000 — 8/10/100/500km all legal. */
export function validateRadiusM(radiusM: number): void {
  if (!Number.isFinite(radiusM) || radiusM < MIN_RADIUS_M || radiusM > MAX_RADIUS_M) {
    throw new RangeError(`Radius must be between ${MIN_RADIUS_M} and ${MAX_RADIUS_M} metres.`);
  }
}

/** Haversine distance in metres. */
export function distanceM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Eligibility: inside radius + live (published window). Radius never scores. */
export function isEligible(
  row: Pick<IntelRow, 'distanceM' | 'kind' | 'observedAt' | 'validUntil'>,
  radiusM: number,
  now: number,
): boolean {
  validateRadiusM(radiusM);
  if (row.observedAt > now) return false;
  if (row.validUntil !== null && row.validUntil <= now) return false;
  // District advisories carry no point: honest regional fallback, not a nearby claim.
  if (row.kind === 'advisory' && row.distanceM === null) return true;
  return row.distanceM !== null && row.distanceM <= radiusM;
}

/** Dedupe: one row per cluster — verified first, then newest, then id. */
export function dedupeByCluster(rows: IntelRow[]): IntelRow[] {
  const best = new Map<string, IntelRow>();
  for (const row of rows) {
    const key = row.clusterId ?? row.id;
    const prev = best.get(key);
    if (!prev) {
      best.set(key, row);
      continue;
    }
    const rank = (r: IntelRow) => (r.evidence === 'expert_verified' ? 0 : 1);
    if (
      rank(row) < rank(prev) ||
      (rank(row) === rank(prev) &&
        (row.observedAt > prev.observedAt || (row.observedAt === prev.observedAt && row.id < prev.id)))
    ) {
      best.set(key, row);
    }
  }
  return [...best.values()];
}

/** Full read path: crop/topic filter → eligibility → dedupe → newest first. */
export function rankIntelFeed(
  rows: IntelRow[],
  opts: { radiusM: number; now: number; cropCode?: string | null; topic?: string | null; limit?: number },
): IntelRow[] {
  const { radiusM, now, cropCode = null, topic = null, limit = 20 } = opts;
  return dedupeByCluster(
    rows.filter(
      (r) =>
        (cropCode === null || r.cropCode === cropCode || r.cropCode === null) &&
        (topic === null || r.topic === topic) &&
        isEligible(r, radiusM, now),
    ),
  )
    .sort((a, b) => b.observedAt - a.observedAt || (a.id < b.id ? -1 : 1))
    .slice(0, Math.max(1, Math.min(limit, 100)));
}
