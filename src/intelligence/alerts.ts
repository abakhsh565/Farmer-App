/**
 * The wire contract between `intelligence_alert_feed()` and the existing Home
 * card and notification sheet.
 *
 * An alert is a canonical recommendation with alert metadata, not a new advice
 * object. This parser validates that contract, preserves the server's order and
 * drops a malformed row rather than rendering a half-alert. It also refuses a
 * non-HTTPS source link; the database has the same rule, but the client must not
 * rely on a single layer for something the farmer can tap.
 */

export type AlertLevel = 'urgent' | 'watch' | 'info';

export type AlertCategory = 'weather' | 'pest' | 'disease' | 'crop_stage';

export type AlertEvidenceTier = 'verified' | 'supplementary' | 'community' | null;

export type AlertSourceKind =
  | 'weather_observation'
  | 'knowledge'
  | 'official_advisory'
  | 'forecast_risk';

export type AlertRow = {
  notificationId: string;
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
  alertSourceKind: AlertSourceKind | null;
  evidenceTier: AlertEvidenceTier;
  confidence: number | null;
  level: AlertLevel;
  alertAt: string | null;
  validUntil: string | null;
  isRead: boolean;
  reasonCode: string | null;
  reasonContext: Record<string, unknown>;
  actionKind: string | null;
  actionLabel: string | null;
  actionLabelUr: string | null;
  createdAt: string | null;
};

const MAX_ROWS = 20;
const LEVELS: readonly AlertLevel[] = ['urgent', 'watch', 'info'];
const EVIDENCE: readonly Exclude<AlertEvidenceTier, null>[] = [
  'verified',
  'supplementary',
  'community',
];
const SOURCE_KINDS: readonly AlertSourceKind[] = [
  'weather_observation',
  'knowledge',
  'official_advisory',
  'forecast_risk',
];

function sourceKind(value: unknown, source: string, reasonCode: string | null): AlertSourceKind | null {
  const candidate = text(value);
  if (candidate !== null && SOURCE_KINDS.includes(candidate as AlertSourceKind)) {
    return candidate as AlertSourceKind;
  }
  // Older rows predate alert_source_kind. Their reason/source still separates a
  // weather observation, an advisory and a forecast risk; never default an
  // unknown row to official.
  if (reasonCode === 'official_advisory') return 'official_advisory';
  if (reasonCode === 'forecast_risk') return 'forecast_risk';
  return source === 'weather' ? 'weather_observation' : null;
}

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

/** Validates an RPC payload and keeps the server's ordering. */
export function parseAlerts(input: unknown): AlertRow[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: AlertRow[] = [];

  for (const raw of input) {
    if (out.length >= MAX_ROWS) break;
    if (!isRecord(raw)) continue;

    const notificationId = text(raw.notification_id ?? raw.notificationId);
    const recommendationId = text(raw.recommendation_id ?? raw.recommendationId);
    const title = text(raw.title);
    const level = text(raw.alert_level ?? raw.alertLevel);
    if (
      notificationId === null ||
      recommendationId === null ||
      title === null ||
      level === null ||
      !LEVELS.includes(level as AlertLevel) ||
      seen.has(notificationId)
    ) {
      continue;
    }

    const tier = text(raw.evidence_tier ?? raw.evidenceTier);
    const reasonCode = text(raw.reason_code ?? raw.reasonCode);
    const confidence =
      typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
        ? raw.confidence
        : null;

    seen.add(notificationId);
    out.push({
      notificationId,
      recommendationId,
      cropId: text(raw.crop_id ?? raw.cropId),
      cropCode: text(raw.crop_code ?? raw.cropCode),
      kind: text(raw.kind) ?? 'general',
      title,
      titleUr: text(raw.title_ur ?? raw.titleUr),
      body: typeof raw.body === 'string' ? raw.body : '',
      bodyUr: text(raw.body_ur ?? raw.bodyUr),
      source: text(raw.source) ?? 'unknown',
      sourceLabel: text(raw.source_label ?? raw.sourceLabel),
      sourceUrl: safeHttpsUrl(raw.source_url ?? raw.sourceUrl),
      alertSourceKind: sourceKind(
        raw.alert_source_kind ?? raw.alertSourceKind,
        text(raw.source) ?? 'unknown',
        reasonCode,
      ),
      evidenceTier:
        tier !== null && EVIDENCE.includes(tier as Exclude<AlertEvidenceTier, null>)
          ? (tier as Exclude<AlertEvidenceTier, null>)
          : null,
      confidence,
      level: level as AlertLevel,
      alertAt: text(raw.alert_at ?? raw.alertAt),
      validUntil: text(raw.valid_until ?? raw.validUntil),
      isRead: raw.is_read === true,
      reasonCode,
      reasonContext: isRecord(raw.reason_context)
        ? raw.reason_context
        : isRecord(raw.reasonContext)
          ? raw.reasonContext
          : {},
      actionKind: text(raw.action_kind ?? raw.actionKind),
      actionLabel: text(raw.action_label ?? raw.actionLabel),
      actionLabelUr: text(raw.action_label_ur ?? raw.actionLabelUr),
      createdAt: text(raw.created_at ?? raw.createdAt),
    });
  }

  return out;
}

export function alertCategory(kind: string): AlertCategory {
  if (kind === 'weather' || kind === 'pest' || kind === 'disease') return kind;
  return 'crop_stage';
}

export function alertTrustKey(row: AlertRow): string | null {
  if (row.alertSourceKind === 'official_advisory' || row.reasonCode === 'official_advisory') return 'official';
  if (row.alertSourceKind === 'forecast_risk' || row.reasonCode === 'forecast_risk') return 'forecast';
  if (row.alertSourceKind === 'weather_observation') return 'weather';
  if (row.alertSourceKind === null && row.source === 'weather') return 'weather';
  if (row.evidenceTier === 'verified') return 'verified';
  if (row.evidenceTier === 'supplementary') return 'supplementary';
  if (row.evidenceTier === 'community') return 'community';
  return null;
}

export function alertIsExpired(row: AlertRow, now = Date.now()): boolean {
  if (!row.validUntil) return false;
  const at = new Date(row.validUntil).getTime();
  return Number.isFinite(at) && at <= now;
}
