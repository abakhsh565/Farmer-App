import { describe, expect, it } from 'vitest';
import {
  QUEUE_LIMIT,
  buildEvent,
  enqueueEvent,
  flushQueue,
  readQueue,
  type IntelligenceEvent,
  type StorageLike,
} from './events';

function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

const NOW = 1_800_000_000_000;

function event(overrides: Partial<IntelligenceEvent> = {}): IntelligenceEvent {
  return {
    key: 'evt-1',
    type: 'insight_open',
    at: NOW,
    source: 'ui_interaction',
    context: {},
    ...overrides,
  };
}

describe('buildEvent', () => {
  it('derives the source from the event type rather than trusting the caller', () => {
    const built = buildEvent({ key: 'k1', type: 'scan_result', at: NOW }, NOW);
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.event.source).toBe('scan');
  });

  it('keeps allowed context and drops anything else', () => {
    const built = buildEvent(
      {
        key: 'k2',
        type: 'search',
        at: NOW,
        subject: 'urea',
        context: { screen: 'Shop', topic: 'fertiliser', message: 'Ali Traders', phone: '03001234567' },
      },
      NOW,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.event.context).toEqual({ screen: 'shop', topic: 'fertiliser' });
  });

  it('refuses a subject that still looks like a name or a phone number', () => {
    expect(buildEvent({ key: 'k3', type: 'dealer_view', at: NOW, subject: 'Ali Traders' }, NOW).ok).toBe(false);
    expect(buildEvent({ key: 'k4', type: 'chat_open', at: NOW, subject: '03001234567' }, NOW).ok).toBe(false);
    expect(buildEvent({ key: 'k5', type: 'chat_open', at: NOW, subject: 'ali@example.com' }, NOW).ok).toBe(false);
  });

  it('refuses unknown types and times outside the accepted window', () => {
    // @ts-expect-error deliberately not a member of the vocabulary
    expect(buildEvent({ key: 'k6', type: 'page_view', at: NOW }, NOW).ok).toBe(false);
    expect(buildEvent({ key: 'k7', type: 'search', at: NOW + 10 * 60 * 1000 }, NOW).ok).toBe(false);
    expect(buildEvent({ key: 'k8', type: 'search', at: NOW - 120 * 24 * 60 * 60 * 1000 }, NOW).ok).toBe(false);
  });

  it('requires an idempotency key', () => {
    expect(buildEvent({ key: '   ', type: 'search', at: NOW }, NOW).ok).toBe(false);
  });
});

describe('the outbox', () => {
  it('records an event once even when it is enqueued twice', () => {
    const storage = memoryStorage();
    enqueueEvent(storage, event({ key: 'same' }));
    enqueueEvent(storage, event({ key: 'same' }));
    expect(readQueue(storage)).toHaveLength(1);
  });

  it('keeps the newest events when it overflows', () => {
    const storage = memoryStorage();
    for (let i = 0; i < QUEUE_LIMIT + 5; i += 1) {
      enqueueEvent(storage, event({ key: `evt-${i}` }));
    }
    const queue = readQueue(storage);
    expect(queue).toHaveLength(QUEUE_LIMIT);
    expect(queue[0]?.key).toBe('evt-5');
    expect(queue.at(-1)?.key).toBe(`evt-${QUEUE_LIMIT + 4}`);
  });

  it('keeps what the server did not accept and stops on the first failure', async () => {
    const storage = memoryStorage();
    enqueueEvent(storage, event({ key: 'a' }));
    enqueueEvent(storage, event({ key: 'b' }));
    enqueueEvent(storage, event({ key: 'c' }));

    const result = await flushQueue(storage, async (queued) => queued.key === 'a');

    expect(result).toEqual({ sent: 1, remaining: 2 });
    expect(readQueue(storage).map((queued) => queued.key)).toEqual(['b', 'c']);
  });

  it('drains everything when every send succeeds', async () => {
    const storage = memoryStorage();
    enqueueEvent(storage, event({ key: 'a' }));
    enqueueEvent(storage, event({ key: 'b' }));

    const result = await flushQueue(storage, async () => true);

    expect(result).toEqual({ sent: 2, remaining: 0 });
    expect(readQueue(storage)).toEqual([]);
  });
});
