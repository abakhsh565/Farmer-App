/**
 * The catalogue's change signal.
 *
 * The dealer catalogue itself lives in the dealer platform, a different project
 * that this app cannot make emit events. What it can subscribe to is its own copy
 * of that catalogue — `dealer_profiles` and `dealer_products` — so the moment a
 * sync (or a shop's own edit that lands here) changes either table, every open
 * screen re-reads immediately instead of waiting for the next poll.
 *
 * One socket for the whole app, opened lazily on the first subscriber and closed
 * when the last one leaves. A build without a backend never opens it at all.
 *
 * Failure is silent by design: `postgres_changes` is an optimisation on top of a
 * poll that still works. If the socket cannot connect, is refused, or drops, the
 * screens keep their timer as the fallback rather than showing an error.
 */

import { serviceConfig } from './config';
import { getSupabaseClient } from './supabaseClient';

type Listener = () => void;

const listeners = new Set<Listener>();
let channel: {
  on: (event: string, filter: unknown, callback: () => void) => unknown;
  subscribe: (callback?: (status: string) => void) => unknown;
  unsubscribe: () => unknown;
} | null = null;
let connecting = false;
let connected = false;

/** True while the socket is joined, false while polls alone are carrying updates. */
export function isCatalogRealtimeConnected(): boolean {
  return connected;
}

function emit() {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* One broken screen must not stop the others' refresh. */
    }
  }
}

async function open() {
  if (channel || connecting || listeners.size === 0) return;
  const supabase = serviceConfig.supabase;
  if (!supabase.configured) return;

  connecting = true;
  try {
    const client = await getSupabaseClient(supabase);
    if (!client || listeners.size === 0) return;
    const socket = client as unknown as {
      channel: (name: string) => {
        on: (event: string, filter: unknown, callback: () => void) => unknown;
        subscribe: (callback?: (status: string) => void) => unknown;
        unsubscribe: () => unknown;
      };
    };
    const next = socket.channel('farmer-catalog');
    next.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'dealer_profiles' },
      emit,
    );
    next.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'dealer_products' },
      emit,
    );
    next.subscribe((status: string) => {
      connected = status === 'SUBSCRIBED';
    });
    channel = next;
  } catch {
    channel = null;
  } finally {
    connecting = false;
  }
}

function close() {
  if (!channel) return;
  try {
    channel.unsubscribe();
  } catch {
    /* already gone */
  }
  channel = null;
  connected = false;
}

/**
 * Run `listener` whenever the catalogue changes. Returns the unsubscribe handle.
 *
 * Callers are screens, so they subscribe and leave with the screen; nothing here
 * holds a reference that would keep a removed screen updating.
 */
export function onCatalogChange(listener: Listener): () => void {
  listeners.add(listener);
  void open();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) close();
  };
}

/** Test seam: drop the socket and the listeners without touching the network. */
export function resetCatalogRealtime(): void {
  close();
  listeners.clear();
}
