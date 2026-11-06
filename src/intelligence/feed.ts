/**
 * The one adapter between `intelligence_recommendation_feed()` and the feed UI.
 *
 * The server returns canonical recommendation rows with localized copy, source
 * metadata and a human-readable reason. The local document remains the offline
 * fallback; it is never overwritten by server rows. This module validates the
 * wire contract and preserves the server's order — it never recomputes a score.
 */

export type RecommendationEvidenceTier = 'verified' | 'supplementary' | 'community';

export type RankedRecommendation = {
  recommendationId: string;
  cropId: string | null;
  cropCode: string | null;
  kind: string;
  title: string;
  titleUr: string | null;
  body: string;
  bodyUr: string | null;
  source: string;
  sourceLabel: string | null;
  sourceUrl: string | null;
  evidenceTier: RecommendationEvidenceTier | null;
  confidence: number | null;
  priority: number;
  score: number;
  components: Record<string, unknown>;
  reasonCode: string | null;
  reasonContext: Record<string, unknown>;
  ruleVersion: number | null;
  actionKind: string | null;
  actionLabel: string | null;
  actionLabelUr: string | null;
  validUntil: string | null;
  createdAt: string | null;
};

const MAX_ROWS = 50;
const EVIDENCE_TIERS: readonly RecommendationEvidenceTier[] = [
  'verified',
  'supplementary',
  'community',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function safeHttpsUrl(value: unknown): string | null {
  const candidate = text(value);
  return candidate !== null && candidate.startsWith('https://') ? candidate : null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Validates and normalises an RPC payload.
 *
 * The order of the input is preserved: the server's ranking is the ranking. A
 * malformed or duplicate row is dropped rather than rendered as a half-card.
 */
export function parseRankedRecommendations(input: unknown): RankedRecommendation[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: RankedRecommendation[] = [];

  for (const raw of input) {
    if (out.length >= MAX_ROWS) break;
    if (!isRecord(raw)) continue;

    const recommendationId =
      typeof raw.recommendation_id === 'string'
        ? raw.recommendation_id
        : typeof raw.recommendationId === 'string'
          ? raw.recommendationId
          : null;
    const title = text(raw.title);
    if (!recommendationId || title === null) continue;
    if (seen.has(recommendationId)) continue;

    const evidence =
      typeof raw.evidence_tier === 'string' && EVIDENCE_TIERS.includes(raw.evidence_tier as RecommendationEvidenceTier)
        ? (raw.evidence_tier as RecommendationEvidenceTier)
        : null;
    const score = numberOr(raw.score, 0);
    const priority = numberOr(raw.priority, 100);
    const confidence =
      typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? raw.confidence : null;
    const ruleVersion =
      typeof raw.rule_version === 'number' && Number.isFinite(raw.rule_version)
        ? raw.rule_version
        : typeof raw.ruleVersion === 'number' && Number.isFinite(raw.ruleVersion)
          ? raw.ruleVersion
          : null;

    seen.add(recommendationId);
    out.push({
      recommendationId,
      cropId:
        typeof raw.cropId === 'string'
          ? raw.cropId
          : typeof raw.crop_id === 'string'
            ? raw.crop_id
            : null,
      cropCode:
        typeof raw.cropCode === 'string'
          ? raw.cropCode
          : typeof raw.crop_code === 'string'
            ? raw.crop_code
            : null,
      kind: text(raw.kind) ?? 'general',
      title,
      titleUr: text(raw.title_ur) ?? text(raw.titleUr),
      body: typeof raw.body === 'string' ? raw.body : '',
      bodyUr: text(raw.body_ur) ?? text(raw.bodyUr),
      source: text(raw.source) ?? 'unknown',
      sourceLabel: text(raw.source_label) ?? text(raw.sourceLabel),
      sourceUrl: safeHttpsUrl(raw.source_url) ?? safeHttpsUrl(raw.sourceUrl),
      evidenceTier: evidence,
      confidence,
      priority,
      score,
      components: isRecord(raw.components) ? raw.components : {},
      reasonCode: text(raw.reason_code) ?? text(raw.reasonCode),
      reasonContext: isRecord(raw.reason_context)
        ? raw.reason_context
        : isRecord(raw.reasonContext)
          ? raw.reasonContext
          : {},
      ruleVersion,
      actionKind: text(raw.action_kind) ?? text(raw.actionKind),
      actionLabel: text(raw.action_label) ?? text(raw.actionLabel),
      actionLabelUr: text(raw.action_label_ur) ?? text(raw.actionLabelUr),
      validUntil:
        typeof raw.valid_until === 'string'
          ? raw.valid_until
          : typeof raw.validUntil === 'string'
            ? raw.validUntil
            : null,
      createdAt:
        typeof raw.created_at === 'string'
          ? raw.created_at
          : typeof raw.createdAt === 'string'
            ? raw.createdAt
            : null,
    });
  }

  return out;
}

type Rankable = { kind: string; cropId: string };

/**
 * Orders local insights by the server's ranking without touching their content.
 * Matched insights rise in the server order; everything else keeps its existing
 * relative order, so a failed match can only leave the local fallback unchanged.
 */
export function orderByServerRanking<T extends Rankable>(
  items: readonly T[],
  ranked: readonly RankedRecommendation[],
): T[] {
  if (items.length === 0 || ranked.length === 0) return [...items];

  const rank = new Map<string, number>();
  ranked.forEach((row, index) => {
    const exact = `${row.kind}|${row.cropId ?? ''}`;
    if (!rank.has(exact)) rank.set(exact, index);
    if (row.cropId) {
      const byKind = `${row.kind}|*`;
      if (!rank.has(byKind)) rank.set(byKind, index);
    }
    if (!rank.has(row.kind)) rank.set(row.kind, index);
  });

  return items
    .map((item, index) => ({
      item,
      index,
      rank:
        rank.get(`${item.kind}|${item.cropId}`) ??
        rank.get(`${item.kind}|*`) ??
        rank.get(item.kind) ??
        Number.POSITIVE_INFINITY,
    }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.item);
}

type InsightIdentity = { id: string; kind: string; cropId: string };

/**
 * Finds the one server recommendation that can honestly stand behind a local
 * insight, or returns null. Ambiguity stays feedback-less rather than attaching
 * a verdict to the wrong recommendation.
 */
export function recommendationForInsight(
  insight: InsightIdentity,
  localInsights: readonly InsightIdentity[],
  ranked: readonly RankedRecommendation[],
): RankedRecommendation | null {
  const sameKind = ranked.filter((row) => row.kind === insight.kind);
  if (sameKind.length === 0) return null;

  const exactCrop = sameKind.filter(
    (row) => row.cropId !== null && row.cropId === insight.cropId,
  );
  if (exactCrop.length === 1) return exactCrop[0] ?? null;
  if (exactCrop.length > 1) return null;

  const localSameKind = localInsights.filter((entry) => entry.kind === insight.kind);
  if (sameKind.length === 1 && localSameKind.length === 1) return sameKind[0] ?? null;

  return null;
}
