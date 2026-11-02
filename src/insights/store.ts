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

/** A crop the farmer has actually added, and the moment advice was raised. */
export type AddCropInput = {
  nameKey: MessageKey;
  stageKey: MessageKey;
  /** Only the farmer can confirm a stage; timing may only suggest one. */
  stageConfirmed?: boolean;
  plantedAt?: number;
};

/**
 * Adding a crop, the one way a crop list ever grows.
 *
 * The farmer's own choice, so the id is derived from the crop and the planting
 * moment rather than a counter — the same crop added twice on two phones is one
 * crop, and an advice set keyed by id stays attached to it.
 */
export function addCrop(data: InsightData, input: AddCropInput, now: number): InsightData {
  const id = `crop-${input.nameKey.replace(/[^a-z0-9]+/gi, '-')}-${input.plantedAt ?? now}`;
  if (data.crops.some((crop) => crop.id === id)) return data;
  /* The first crop a farmer adds is their main crop without being asked. */
  const crop: CropInstance = {
    id,
    nameKey: input.nameKey,
    stageKey: input.stageKey,
    stageConfirmed: input.stageConfirmed === true,
    plantedAt: input.plantedAt ?? now,
    primary: data.crops.length === 0,
  };
  return { ...data, crops: [...data.crops, crop] };
}

/**
 * "This is my crop" as one write, whether or not it is already on the list.
 *
 * `addCrop` derives the id from the planting moment, so a crop the farmer told
 * us about during onboarding has a different id from one they pick again today —
 * which would leave two Cottons in the strip. So the name is matched first, and
 * a crop already on the list is simply promoted. Doing this from a screen as
 * add-then-make-primary is not possible: the id `addCrop` invents is not known
 * until the document has been written.
 */
export function chooseCrop(data: InsightData, input: AddCropInput, now: number): InsightData {
  const existing = data.crops.find((crop) => crop.nameKey === input.nameKey);
  if (existing) return makePrimary(data, existing.id);

  const withCrop = addCrop(data, input, now);
  const added = withCrop.crops.find((crop) => crop.nameKey === input.nameKey);
  return added ? makePrimary(withCrop, added.id) : withCrop;
}

export function removeCrop(data: InsightData, cropId: string): InsightData {
  const remaining = data.crops.filter((crop) => crop.id !== cropId);
  if (remaining.length === data.crops.length) return data;
  /* Removing the main crop hands the role to whatever is left, so the app is
     never left pointing at a crop that is gone. */
  const stillHasPrimary = remaining.some((crop) => crop.primary);
  return {
    ...data,
    crops: stillHasPrimary ? remaining : remaining.map((crop, index) => ({ ...crop, primary: index === 0 })),
  };
}

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

/**
 * The first run: a farmer who has not told this app what they grow.
 *
 * It used to seed two crops and three pieces of advice about them, so every
 * install opened on a pink bollworm alert for cotton the farmer had never
 * planted. The advice was internally consistent and completely invented, which
 * is the worst combination available: it looked like the product working, so
 * nobody would think to check whether it belonged to them. On a phone that
 * changes hands it was simply the previous farmer's field, read as yours.
 *
 * So the seed is empty, and the recommendation surfaces say nothing rather than
 * something untrue: `InsightCard` renders no card without a primary crop, and
 * the crop strip needs two crops before it draws. What appears on Home is what
 * the farmer actually has.
 */
export function createSeed(_now: number): InsightData {
  return { crops: [], insights: [], notifications: [] };
}
