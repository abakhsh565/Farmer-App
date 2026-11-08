/**
 * Behaviour events: the vocabulary, the validation, and the queue.
 *
 * Three rules shape this file, and each one exists because the obvious version
 * of this code goes wrong in a way that is hard to see later.
 *
 *  1. **No free text leaves the device.** An event says *what kind of thing*
 *     happened and which slug it was about. It never carries a search query, a
 *     message, a name or a coordinate. A query can contain a farmer's name, and
 *     the analytics table is not a place to discover it.
 *  2. **Every event has an idempotency key.** A flush that times out is retried;
 *     without a key, the same tap is recorded twice and a farmer's interest is
 *     double-weighted by a bad connection.
 *  3. **Nothing here throws.** Telemetry is optional by definition: if storage is
 *     full or a value is malformed, the app keeps working and the event is
 *     dropped, rather than a screen failing because an analytics call did.
 */

export const INTELLIGENCE_EVENTS = [
  'screen_view',
  'search',
  'product_view',
  'dealer_view',
  'insight_open',
  'insight_act',
  'insight_dismiss',
  'scan_start',
  'scan_result',
  'chat_open',
  'community_read',
  'notification_open',
  'preference_set',
  'feedback',
] as const;

export type IntelligenceEventType = (typeof INTELLIGENCE_EVENTS)[number];

/** The server's own source vocabulary. Kept identical on purpose. */
export type IntelligenceSource =
  | 'ui_interaction'
  | 'search'
  | 'scan'
  | 'chat'
  | 'community_read'
  | 'notification_open';

export type EventContext = {
  screen?: string;
  cropCode?: string;
  stage?: string;
  topic?: string;
  productId?: string;
  dealerId?: string;
  rank?: number;
};

export type IntelligenceEvent = {
  /** Client-generated idempotency key. */
  key: string;
  type: IntelligenceEventType;
  /** Epoch milliseconds, from the device clock. */
  at: number;
  source: IntelligenceSource;
  subject?: string;
  cropCode?: string;
  stage?: string;
  context?: EventContext;
};

export type EventInput = Omit<IntelligenceEvent, 'context' | 'source'> & {
  context?: Record<string, unknown>;
};

export type BuildResult =
  | { ok: true; event: IntelligenceEvent }
  | { ok: false; reason: string };

const SOURCE_BY_TYPE: Record<IntelligenceEventType, IntelligenceSource> = {
  screen_view: 'ui_interaction',
  search: 'search',
  product_view: 'ui_interaction',
  dealer_view: 'ui_interaction',
  insight_open: 'ui_interaction',
  insight_act: 'ui_interaction',
  insight_dismiss: 'ui_interaction',
  scan_start: 'scan',
  scan_result: 'scan',
  chat_open: 'chat',
  community_read: 'community_read',
  notification_open: 'notification_open',
  preference_set: 'ui_interaction',
  feedback: 'ui_interaction',
};

/** Lowercase slug, as the database's own check constraint requires. */
export function normaliseSlug(value: string): string | null {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9:_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug.length === 0 ? null : slug;
}

/**
 * A subject is a slug, never a sentence.
 *
 * The length cap is not the point — the point is that a phone number, an email
 * address or a name with a space in it cannot pass through unchanged. If a
 * caller tries to send one, the event is refused rather than silently trimmed
 * into something that still identifies a person.
 */
export function isSafeSubject(value: string): boolean {
  if (!/^[a-z0-9][a-z0-9:_-]{0,79}$/.test(value)) return false;
  // Digit runs long enough to be a phone number or an ID.
  if (/\d{6,}/.test(value)) return false;
  return true;
}

const CONTEXT_KEYS: ReadonlySet<string> = new Set(Object.keys({
  screen: '',
  cropCode: '',
  stage: '',
  topic: '',
  productId: '',
  dealerId: '',
  rank: 0,
} satisfies Record<keyof EventContext, unknown>));

/**
 * Only known context keys survive, and each must be a short scalar.
 *
 * An allowlist rather than a blocklist: a caller cannot add a `message` field
 * later and have it silently shipped because nobody remembered to forbid it.
 */
export function sanitiseContext(raw: Record<string, unknown> | undefined): EventContext {
  const out: EventContext = {};
  if (!raw) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!CONTEXT_KEYS.has(key)) continue;
    if (typeof value === 'string') {
      const slug = normaliseSlug(value);
      if (slug !== null) (out as Record<string, unknown>)[key] = slug;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

export function buildEvent(input: EventInput, now: number = Date.now()): BuildResult {
  if (!INTELLIGENCE_EVENTS.includes(input.type)) {
    return { ok: false, reason: 'unknown-event-type' };
  }
  if (typeof input.key !== 'string' || input.key.trim().length === 0 || input.key.length > 100) {
    return { ok: false, reason: 'invalid-key' };
  }
  if (!Number.isFinite(input.at) || input.at < now - 90 * 24 * 60 * 60 * 1000 || input.at > now + 5 * 60 * 1000) {
    return { ok: false, reason: 'invalid-time' };
  }

  let subject: string | undefined;
  if (input.subject !== undefined) {
    // Normalising a sentence into a slug would preserve the words; a subject must
    // already *be* a slug, or it is refused.
    const candidate = input.subject.trim().toLowerCase();
    if (/s|@/.test(candidate) || !isSafeSubject(candidate)) {
      return { ok: false, reason: 'unsafe-subject' };
    }
    subject = candidate;
  }

  const event: IntelligenceEvent = {
    key: input.key.trim(),
    type: input.type,
    at: input.at,
    source: SOURCE_BY_TYPE[input.type],
    ...(subject ? { subject } : {}),
    ...(input.cropCode ? { cropCode: normaliseSlug(input.cropCode) ?? undefined } : {}),
    ...(input.stage ? { stage: normaliseSlug(input.stage) ?? undefined } : {}),
    context: sanitiseContext(input.context),
  };
  return { ok: true, event };
}

/* -------------------------------------------------------------------------- */
/* The queue                                                                  */
/* -------------------------------------------------------------------------- */

export const QUEUE_KEY = 'agri-shop.intelligence.outbox';
export const QUEUE_LIMIT = 100;

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

type Queued = IntelligenceEvent[];

export function readQueue(storage: StorageLike): Queued {
  try {
    const raw = storage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is IntelligenceEvent =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as IntelligenceEvent).key === 'string' &&
        INTELLIGENCE_EVENTS.includes((entry as IntelligenceEvent).type),
    );
  } catch {
    return [];
  }
}

function writeQueue(storage: StorageLike, queue: Queued): void {
  try {
    storage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    /* Full or blocked storage: the queue is best-effort, the app is not. */
  }
}

/**
 * Adds an event at most once and drops the oldest when full.
 *
 * Dropping the oldest rather than refusing the newest is deliberate: after a
 * week offline, the most recent behaviour is what describes the farmer now.
 */
export function enqueueEvent(storage: StorageLike, event: IntelligenceEvent): Queued {
  const queue = readQueue(storage);
  if (queue.some((entry) => entry.key === event.key)) return queue;
  const next = [...queue, event].slice(-QUEUE_LIMIT);
  writeQueue(storage, next);
  return next;
}

export function removeEvents(storage: StorageLike, keys: readonly string[]): Queued {
  const drop = new Set(keys);
  const next = readQueue(storage).filter((entry) => !drop.has(entry.key));
  writeQueue(storage, next);
  return next;
}

/**
 * Sends what is queued, keeping anything the server did not accept.
 *
 * A `false` return means "not accepted" rather than "delivered and rejected".
 * The distinction matters: a permanent refusal should not be retried forever,
 * but this layer cannot tell the two apart, and dropping a farmer's behaviour on
 * a transient 503 is worse than one extra retry. The server's own idempotency
 * key is what makes the retry safe.
 */
export async function flushQueue(
  storage: StorageLike,
  send: (event: IntelligenceEvent) => Promise<boolean>,
): Promise<{ sent: number; remaining: number }> {
  const queue = readQueue(storage);
  const accepted: string[] = [];

  for (const event of queue) {
    let ok = false;
    try {
      ok = await send(event);
    } catch {
      ok = false;
    }
    if (!ok) break;
    accepted.push(event.key);
  }

  if (accepted.length > 0) removeEvents(storage, accepted);
  return { sent: accepted.length, remaining: readQueue(storage).length };
}

/** A key that is unique per device and event, without requiring a backend. */
export function eventKey(prefix: string, now: number = Date.now()): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `${prefix}-${now.toString(36)}-${random}`;
}
