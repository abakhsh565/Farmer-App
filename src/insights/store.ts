import type { MessageKey } from '@/i18n/catalog';

/**
 * The canonical Recommendation/Insight — one object, consumed by everything.
 *
 * The rule this store exists to enforce: Home, the notification sheet and the
 * detail view must render the *same record*. A notification therefore does not
 * carry a title; it carries the id of an insight, and the surfaces look it up.
 * Two wordings for one recommendation is how a farmer gets told two different
 * things about the same crop.
 *
 * Crops are instances with their own lifecycle, and each insight belongs to one.
 * Recommendations are evaluated per crop — a cotton alert sitting in front of a
 * wheat one is a ranking decision, never a suppression. A stage that came from
 * timing is marked as estimated until the farmer confirms it: inferred is not
 * the same as known, and the store says which is which.
 *
 * Lifecycle: active → viewed → acted-on / dismissed, plus expiry by validity
 * window. Dismissal is per insight and revocable by a *new* insight; behaviour
 * (what the farmer taps) never silently rewrites a crop fact here.
 */

export type CropInstance = {
  id: string;
  nameKey: MessageKey;
  stageKey: MessageKey;
  /** Timing suggests this stage; only the farmer confirms it. */
  stageConfirmed: boolean;
  plantedAt: number;
  /** The farmer's explicit choice, from the crop strip. */
  primary: boolean;
};

export type InsightKind = 'pest' | 'weather' | 'activity' | 'market';

export type InsightStatus = 'active' | 'viewed' | 'acted' | 'dismissed';

export type Insight = {
  id: string;
  cropId: string;
  kind: InsightKind;
  priority: 'high' | 'normal';
  titleKey: MessageKey;
  bodyKey: MessageKey;
  actionKey: MessageKey;
  /** Where the claim comes from — visible on every surface that shows it. */
  sourceKey: MessageKey;
  knowledgeVersion: string;
  confidence: number;
  createdAt: number;
  validUntil: number;
  status: InsightStatus;
};

export type InsightNotification = {
  id: string;
  /** The insight itself, not a copy of its words. */
  insightId: string;
  at: number;
  read: boolean;
};

export type InsightData = {
  crops: CropInstance[];
  insights: Insight[];
  notifications: InsightNotification[];
};

const DAY = 24 * 60 * 60 * 1000;

export function stageIsEstimate(crop: CropInstance): boolean {
  return !crop.stageConfirmed;
}

/** The farmer's featured crop, or the first one if they have not chosen yet. */
export function primaryCrop(data: InsightData): CropInstance | undefined {
  return data.crops.find((crop) => crop.primary) ?? data.crops[0];
}

export function cropById(data: InsightData, id: string): CropInstance | undefined {
  return data.crops.find((crop) => crop.id === id);
}

/** Insights still worth showing: not dismissed, not acted on, not expired. */
export function activeForCrop(data: InsightData, cropId: string, now: number): Insight[] {
  return data.insights
    .filter(
      (insight) =>
        insight.cropId === cropId &&
        (insight.status === 'active' || insight.status === 'viewed') &&
        insight.validUntil > now,
    )
    .sort((a, b) => priority(b) - priority(a) || b.createdAt - a.createdAt);
}

function priority(insight: Insight): number {
  return insight.priority === 'high' ? 1 : 0;
}

export function insightById(data: InsightData, id: string): Insight | undefined {
  return data.insights.find((insight) => insight.id === id);
}

/**
 * One notification per crop at most, newest first, and only while its insight is
 * still live. The anti-noise rule the PRD asks for — more than one crop must not
 * mean a stack of alerts about the same morning.
 *
 * Expiry is derived from the validity window rather than written into the record:
 * a stale insight does not need to be mutated to stop being true.
 */
export function visibleNotifications(data: InsightData, now: number): InsightNotification[] {
  const seen = new Set<string>();
  const out: InsightNotification[] = [];
  for (const entry of [...data.notifications].sort((a, b) => b.at - a.at)) {
    const insight = insightById(data, entry.insightId);
    if (!insight) continue;
    const live =
      (insight.status === 'active' || insight.status === 'viewed') && insight.validUntil > now;
    if (!live) continue;
    if (seen.has(insight.cropId)) continue;
    seen.add(insight.cropId);
    out.push(entry);
  }
  return out;
}

export function markViewed(data: InsightData, id: string): InsightData {
  return {
    ...data,
    insights: data.insights.map((insight) =>
      insight.id === id && insight.status === 'active'
        ? { ...insight, status: 'viewed' }
        : insight,
    ),
    notifications: data.notifications.map((entry) =>
      entry.insightId === id ? { ...entry, read: true } : entry,
    ),
  };
}

export function markActed(data: InsightData, id: string): InsightData {
  return {
    ...data,
    insights: data.insights.map((insight) =>
      insight.id === id ? { ...insight, status: 'acted' } : insight,
    ),
    notifications: data.notifications.map((entry) =>
      entry.insightId === id ? { ...entry, read: true } : entry,
    ),
  };
}

export function dismiss(data: InsightData, id: string): InsightData {
  return {
    ...data,
    insights: data.insights.map((insight) =>
      insight.id === id ? { ...insight, status: 'dismissed' } : insight,
    ),
    notifications: data.notifications.map((entry) =>
      entry.insightId === id ? { ...entry, read: true } : entry,
    ),
  };
}

/** An explicit farmer choice, applied to one crop and removed from the others. */
export function makePrimary(data: InsightData, cropId: string): InsightData {
  return {
    ...data,
    crops: data.crops.map((crop) => ({ ...crop, primary: crop.id === cropId })),
  };
}

export function markAllRead(data: InsightData): InsightData {
  return { ...data, notifications: data.notifications.map((entry) => ({ ...entry, read: true })) };
}

export function unreadCount(data: InsightData, now: number): number {
  return visibleNotifications(data, now).filter((entry) => !entry.read).length;
}

export function serialise(data: InsightData): string {
  return JSON.stringify(data);
}

export function hydrate(raw: string | null): InsightData | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as InsightData;
    if (!Array.isArray(parsed.crops) || !Array.isArray(parsed.insights)) return null;
    if (!Array.isArray(parsed.notifications)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** The demo position: two crops running in parallel, each with its own advice. */
export function createSeed(now: number): InsightData {
  const cotton: CropInstance = {
    id: 'crop-cotton',
    nameKey: 'crop.cotton',
    stageKey: 'crop.stage.bollFormation',
    /* Nobody has told the app the stage — the planting date suggests it. */
    stageConfirmed: false,
    plantedAt: now - 118 * DAY,
    primary: true,
  };
  const wheat: CropInstance = {
    id: 'crop-wheat',
    nameKey: 'crop.wheat',
    stageKey: 'crop.stage.sowing',
    stageConfirmed: true,
    plantedAt: now - 6 * DAY,
    primary: false,
  };

  const insights: Insight[] = [
    {
      id: 'insight-cotton-pest',
      cropId: cotton.id,
      kind: 'pest',
      priority: 'high',
      titleKey: 'insight.pest.title',
      bodyKey: 'insight.pest.body',
      actionKey: 'insight.pest.action',
      sourceKey: 'source.punjabAgri',
      knowledgeVersion: 'kb-2026.41',
      confidence: 82,
      createdAt: now - 2 * 60 * 60 * 1000,
      validUntil: now + 3 * DAY,
      status: 'active',
    },
    {
      id: 'insight-wheat-sowing',
      cropId: wheat.id,
      kind: 'activity',
      priority: 'normal',
      titleKey: 'insight.wheat.title',
      bodyKey: 'insight.wheat.body',
      actionKey: 'insight.wheat.action',
      sourceKey: 'source.punjabAgri',
      knowledgeVersion: 'kb-2026.41',
      confidence: 90,
      createdAt: now - 5 * 60 * 60 * 1000,
      validUntil: now + 5 * DAY,
      status: 'active',
    },
    {
      id: 'insight-cotton-water',
      cropId: cotton.id,
      kind: 'weather',
      priority: 'normal',
      titleKey: 'insight.irrigation.title',
      bodyKey: 'insight.irrigation.body',
      actionKey: 'insight.irrigation.action',
      sourceKey: 'source.weather',
      knowledgeVersion: 'kb-2026.41',
      confidence: 74,
      createdAt: now - 9 * 60 * 60 * 1000,
      validUntil: now + 2 * DAY,
      status: 'active',
    },
  ];

  return {
    crops: [cotton, wheat],
    insights,
    notifications: [
      { id: 'notif-1', insightId: 'insight-cotton-pest', at: now - 2 * 60 * 60 * 1000, read: false },
      { id: 'notif-2', insightId: 'insight-wheat-sowing', at: now - 5 * 60 * 60 * 1000, read: false },
    ],
  };
}
