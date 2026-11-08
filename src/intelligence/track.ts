/**
 * The one seam a screen uses to record behaviour.
 *
 * Screens call `track(...)` and forget about it: the event is validated, written
 * to the outbox immediately, and drained in the background. There is no await in
 * a tap handler, no spinner, and no path where a failed analytics call can stop
 * a farmer from acting on their crop.
 *
 * The outbox exists because the alternative — fire-and-forget RPC — loses the
 * event precisely when the connection is worst, which is the ordinary condition
 * this app is built for. The server's idempotency key makes the retry safe.
 */

import { serviceConfig } from '@/services/config';
import { getIntelligenceGateway } from './client';
import {
  buildEvent,
  enqueueEvent,
  eventKey,
  flushQueue,
  type EventInput,
  type IntelligenceEvent,
  type StorageLike,
} from './events';

/** Guard so a burst of taps causes one drain, not one per tap. */
let draining = false;

function storage(): StorageLike | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function drain(outbox: StorageLike): void {
  if (draining) return;
  draining = true;
  void (async () => {
    try {
      const gateway = await getIntelligenceGateway(serviceConfig.supabase);
      if (gateway) {
        await flushQueue(outbox, (event) => gateway.sendEvent(event));
      }
    } catch {
      /* The queue keeps the events; the next tap or launch tries again. */
    } finally {
      draining = false;
    }
  })();
}

/**
 * Records one event. Never throws, never blocks, never sends free text.
 *
 * The return value exists for tests and for callers that want to know whether the
 * event was accepted by validation; production UI ignores it.
 */
export function track(input: Omit<EventInput, 'key' | 'at'> & { key?: string; at?: number }): boolean {
  const outbox = storage();
  if (!outbox) return false;

  const built = buildEvent(
    {
      ...input,
      key: input.key ?? eventKey(input.type),
      at: input.at ?? Date.now(),
    },
    Date.now(),
  );

  if (!built.ok) return false;
  enqueueEvent(outbox, built.event);
  drain(outbox);
  return true;
}

/** Test seam: enqueue without attempting a network drain. */
export function trackOffline(event: IntelligenceEvent): void {
  const outbox = storage();
  if (outbox) enqueueEvent(outbox, event);
}

/** Test seam: the events waiting to be sent. */
export function pendingEvents(): IntelligenceEvent[] {
  const outbox = storage();
  if (!outbox) return [];
  try {
    const raw = outbox.getItem('agri-shop.intelligence.outbox');
    return raw ? (JSON.parse(raw) as IntelligenceEvent[]) : [];
  } catch {
    return [];
  }
}
