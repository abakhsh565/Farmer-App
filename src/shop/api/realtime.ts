import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { ShopApiConfig } from '@/services/config';

/**
 * The shop's live channel, as this app subscribes to it.
 *
 * WHY A SECOND CLIENT. The app already has a Supabase client, but it points at the
 * farmer app's own project. The shop is a different project with a different anon
 * key, and a Realtime socket belongs to exactly one project — so the socket that
 * hears the shop has to be opened with the shop's own URL and key, the same pair
 * `callShopRpc` uses. Nothing here is a session: the farmer's credential is not a
 * JWT and is never used as a bearer token.
 *
 * WHY THE TOPIC IS NOT DERIVED HERE. `farmer_api_me` answers `realtime_topic`, which
 * the shop computes from the hash of this farmer's credential. The app cannot and
 * should not compute it: only the credential holder is given it, and rotating the
 * credential changes it. An app that guessed `farmer:<farmer_id>` would be reading a
 * topic anyone could name.
 *
 * WHAT ARRIVES. `message` (anything written into the conversation, either side),
 * `request` (a credit ask created, an offer revised, or an answer) and `visit` (a
 * visit scheduled or moved). The payload always names `direction`, so this module
 * drops the farmer's own message echo — re-reading the thread because of the line
 * that was just sent locally is a wasted round trip, not a delivery.
 *
 * RECONNECTING. Supabase Realtime reconnects on its own; this module reports a
 * *second* `ready` as an event so the caller resyncs. That is deliberate: a socket
 * that dropped while the phone was underground missed frames it will never replay,
 * and the only correct answer is to read the thread again.
 */

export type ShopRealtimeEvent = 'message' | 'request' | 'visit' | 'ready';

type Cached = { url: string; key: string; client: SupabaseClient };

/* One client per shop backend, kept for the session. Creating a client per
   subscription would open a socket per screen. */
let cached: Cached | null = null;

function shopClient(config: ShopApiConfig): SupabaseClient | null {
  if (!config.configured || !config.url || !config.key) return null;
  if (cached && cached.url === config.url && cached.key === config.key) return cached.client;

  const client = createClient(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  cached = { url: config.url, key: config.key, client };
  return client;
}

/** True for the one event that is this app's own write coming back. */
function isOwnEcho(payload: unknown): boolean {
  const row = (payload ?? {}) as { payload?: { direction?: unknown } };
  return row.payload?.direction === 'farmer';
}

/**
 * Listen to one farmer's topic. Returns a stop function; calling it twice is safe.
 *
 * `topic` is a capability: a wrong or missing one simply subscribes to a channel
 * nothing writes to, which is why a null topic is a no-op rather than an error.
 */
export function subscribeShopTopic(
  config: ShopApiConfig,
  topic: string | null | undefined,
  onEvent: (event: ShopRealtimeEvent) => void,
): () => void {
  const client = shopClient(config);
  if (!client || !topic) return () => {};

  const channel = client.channel(topic, { config: { broadcast: { self: false } } });

  channel.on('broadcast', { event: 'message' }, (message: unknown) => {
    if (isOwnEcho(message)) return;
    onEvent('message');
  });
  channel.on('broadcast', { event: 'request' }, () => onEvent('request'));
  channel.on('broadcast', { event: 'visit' }, () => onEvent('visit'));

  let joins = 0;
  channel.subscribe((status) => {
    if (status !== 'SUBSCRIBED') return;
    joins += 1;
    /* The first join immediately follows a full read, so it needs no resync. Every
       later one is a reconnection, and is the one moment the screen is stale. */
    if (joins > 1) onEvent('ready');
  });

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    void client.removeChannel(channel);
  };
}
