import type { ChatAudio, ChatImage, ChatMessage } from '@/data/chat';
import type { ShopMediaRow } from './media';

/**
 * The shop backend's responses, as this app understands them.
 *
 * The contract fixes the *calls* and their parameters; it does not pin the shape
 * of what comes back beyond naming the fields each call is for. Two things follow
 * from that, and both are deliberate:
 *
 *  · Every reader here is tolerant about where a field sits — `shop` or `branch`,
 *    `credit_requests` or `requests` — because a backend that renames a key must
 *    not blank the farmer's conversation.
 *  · Nothing is invented. A thread without messages is an empty thread, a message
 *    without a body and without a file is dropped rather than rendered as an empty
 *    bubble, and a field that is missing stays missing so the screen can say it does
 *    not know.
 */

export type ShopMe = {
  farmerId: string;
  farmerName: string | null;
  shopId: string;
  shopName: string;
  shopPhone: string | null;
};

export type ShopOffer = {
  id: string;
  amount: number | null;
  note: string | null;
  status: string;
};

export type ShopVisit = {
  id: string;
  purpose: string | null;
  window: string | null;
  status: string;
};

export type ShopThread = {
  shopName: string | null;
  shopPhone: string | null;
  messages: ChatMessage[];
  offers: ShopOffer[];
  visits: ShopVisit[];
};

/** One shop as the dealer platform lists it to a connected farmer. */
export type ShopSummary = {
  shopId: string;
  name: string;
  city: string | null;
  locationLabel: string | null;
  phone: string | null;
  logoUrl: string | null;
  latitude: number | null;
  longitude: number | null;
  /** True when this farmer already has a credential for it. */
  isLinked: boolean;
};

/** `farmer_api_shops` — `{ shops: [...] }`, tolerant of a bare array. */
export function normaliseShops(value: unknown): ShopSummary[] {
  const row = record(value);
  const list = Array.isArray(row.shops) ? row.shops : Array.isArray(value) ? value : [];
  const shops: ShopSummary[] = [];

  for (const entry of list) {
    const item = record(entry);
    const shopId = text(firstOf(item, ['shop_id', 'shopId', 'id']));
    const name = text(firstOf(item, ['name', 'shop_name', 'shopName']));
    /* A shop with no id cannot be opened or messaged, so it is not listed. */
    if (!shopId || !name) continue;

    shops.push({
      shopId,
      name,
      city: text(item.city),
      locationLabel: text(firstOf(item, ['location_label', 'locationLabel', 'address'])),
      phone: text(firstOf(item, ['phone', 'shop_phone', 'shopPhone'])),
      logoUrl: text(firstOf(item, ['logo_url', 'logoUrl'])),
      latitude: numberOrNull(item.latitude),
      longitude: numberOrNull(item.longitude),
      isLinked: item.is_linked === true,
    });
  }

  return shops;
}

export type ShopNotification = {
  id: string;
  kind: string;
  title: string;
  body: string;
  createdAt: string | null;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function numberOrNull(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function firstOf(source: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return null;
}

/** PostgREST returns a scalar row as an object or as a one-row array; accept both. */
export function firstRow(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    return value.length > 0 ? record(value[0]) : null;
  }
  const single = record(value);
  return Object.keys(single).length > 0 ? single : null;
}

/**
 * `farmer_api_me` — who this credential belongs to.
 *
 * A `token` in the response is ignored: the app already holds one, and adopting a
 * second from a payload would let a stale response overwrite a fresh credential.
 *
 * Two shapes are read, because the shop answers with the second one and an older
 * build of this app expected the first:
 *
 *   `{farmer_id, shop_id, shop_name}`                     — one shop per credential
 *   `{id, name, shops: [{shop_id, shop_name}]}`           — the shop's actual answer
 *
 * A farmer joined to one shop still has exactly one conversation here, so the
 * first entry of `shops` stands in for the pair. Reading only the flat shape was
 * why a valid credential was reported as "not recognised by the shop".
 */
export function normaliseMe(value: unknown): ShopMe | null {
  const row = firstRow(value);
  if (!row) return null;

  const shop = record(firstOf(row, ['shop', 'branch']));
  const shops = Array.isArray(row.shops) ? row.shops : [];
  const joined = record(shops[0] ?? {});

  const farmerId = text(firstOf(row, ['farmer_id', 'farmerId', 'id']));
  const shopId =
    text(firstOf(row, ['shop_id', 'shopId'])) ??
    text(shop.id) ??
    text(firstOf(joined, ['shop_id', 'shopId', 'id']));

  /* Without these two the credential points at nothing this app can show. */
  if (!farmerId || !shopId) return null;

  return {
    farmerId,
    farmerName: text(firstOf(row, ['farmer_name', 'farmerName', 'name'])),
    shopId,
    shopName:
      text(firstOf(row, ['shop_name', 'shopName'])) ??
      text(shop.name) ??
      text(firstOf(joined, ['shop_name', 'shopName', 'name'])) ??
      '',
    shopPhone: text(firstOf(row, ['shop_phone', 'phone'])) ?? text(shop.phone),
  };
}

/**
 * A message row, as a chat bubble.
 *
 * The shop marks each row with `direction`, and its two values are the two
 * parties: `farmer` for what the farmer sent, `owner` for the shop's reply. That
 * is not the same vocabulary as `sender_role`/`outbound`, so all of them are read:
 * recognising only `outbound` drew the farmer's own messages on the shop's side of
 * the conversation, and made his join notice look like an incoming line.
 *
 * A row that names no side at all is drawn as the shop's, since assuming the
 * farmer wrote it would show him his own words as a reply.
 */
/**
 * A voice row, as the shop stores it.
 *
 * The shop records `kind = 'voice'` beside the object it stored, and returns a
 * signed `audio_url` in the thread so playback needs no second round trip. The
 * duration is read from whichever name the backend uses — milliseconds first, then
 * seconds — because a bar that says `0:00` for a real recording reads as a broken
 * message rather than a missing field.
 */
function normaliseVoice(row: Record<string, unknown>): ChatAudio | null {
  const kind = (text(firstOf(row, ['kind', 'message_kind', 'type'])) ?? '').toLowerCase();
  const url = text(firstOf(row, ['audio_url', 'voice_url', 'audioUrl', 'signed_url']));
  const flagged = row.audio === true || row.voice === true;
  if (!flagged && kind !== 'voice' && kind !== 'audio' && !url) return null;

  const asMs = (value: unknown): number => {
    const number = typeof value === 'number' ? value : Number(text(value));
    return Number.isFinite(number) && number > 0 ? number : 0;
  };

  const hoursMs = asMs(firstOf(row, ['duration_ms', 'durationMs', 'audio_duration_ms']));
  const seconds = asMs(firstOf(row, ['duration_seconds', 'duration_s', 'duration']));
  const durationMs = hoursMs > 0 ? hoursMs : seconds > 0 ? Math.round(seconds * 1000) : 0;

  return {
    /* Not every backend signs the URL on every read; a null here draws the bubble
       with a duration and a disabled play control rather than hiding the message. */
    url,
    durationMs,
    mimeType: text(firstOf(row, ['mime_type', 'mimeType'])),
    status: 'sent',
  };
}

function normaliseMessage(
  value: unknown,
  index: number,
  media: ShopMediaRow | undefined,
): ChatMessage | null {
  const row = record(value);
  const body = text(firstOf(row, ['body', 'text', 'message']))?.trim();
  const serverId = text(row.id);

  /*
   * The file, from the thread's own media call rather than from the message row.
   *
   * The shop keeps them apart on purpose: `farmer_api_thread` says who said what,
   * `farmer_api_media` says which messages carry a file and how long it runs. So the
   * two are joined here by message id, and a message with no attachment is an
   * ordinary message. The older inline shape (`kind`/`audio_url` on the row) is still
   * read as a fallback, because a backend that returns it is telling the truth too.
   */
  const voice: ChatAudio | null =
    media?.kind === 'voice'
      ? {
          /* Never a stored URL: the shop mints a sixty-second signature on demand. */
          url: null,
          durationMs: media.durationMs ?? 0,
          mimeType: media.mimeType,
          status: 'sent',
          serverId,
        }
      : media
        ? null
        : normaliseVoice(row);

  const image: ChatImage | null =
    media?.kind === 'image'
      ? {
          url: null,
          mimeType: media.mimeType,
          width: media.width,
          height: media.height,
          status: 'sent',
          serverId,
        }
      : null;

  /* A voice note or a photo has no text of its own, so the old "drop anything without
     a body" rule would have silently deleted every recording and picture. */
  if (!body && !voice && !image) return null;

  const role = (text(firstOf(row, ['sender_role', 'role'])) ?? '').toLowerCase();
  const direction = (text(row.direction) ?? '').toLowerCase();
  const mine =
    role === 'farmer' || direction === 'farmer' || direction === 'outbound' || direction === 'out';

  return {
    /* The thread's own order is the identity React needs: ids from two servers
       (a uuid here, an integer in the local store) must not be mixed. */
    id: index + 1,
    from: mine ? 'me' : 'dealer',
    /* The shop's id, kept for the one thing it is for: asking for this message's
       file link. It is not used as a React key. */
    ...(serverId ? { serverId } : {}),
    text: body ?? undefined,
    ...(voice ? { audio: voice } : {}),
    ...(image ? { image } : {}),
  };
}

export function normaliseThread(value: unknown, media: ShopMediaRow[] = []): ShopThread {
  const row = firstRow(value) ?? {};
  const shop = record(firstOf(row, ['shop', 'branch']));
  const rawMessages = firstOf(row, ['messages', 'thread', 'chat']) ?? [];
  const mediaByMessage = new Map(media.map((entry) => [entry.messageId, entry]));

  const messages = (Array.isArray(rawMessages) ? rawMessages : [])
    .map((message, index) => {
      const serverId = text(record(message).id);
      return normaliseMessage(message, index, serverId ? mediaByMessage.get(serverId) : undefined);
    })
    .filter((message): message is ChatMessage => message !== null);

  const offers = (Array.isArray(firstOf(row, ['credit_requests', 'creditRequests', 'requests', 'offers']))
    ? (firstOf(row, ['credit_requests', 'creditRequests', 'requests', 'offers']) as unknown[])
    : []
  )
    .map((entry) => {
      const offer = record(entry);
      const id = text(offer.id);
      if (!id) return null;
      /* The shop names these by what was asked for (`requested_amount`) and what it
         offered (`offer_total`); the older flat names are still read beside them. */
      const raw = firstOf(offer, ['amount', 'requested_amount', 'offer_total']);
      const amount = typeof raw === 'number' ? raw : Number(text(raw));
      return {
        id,
        amount: Number.isFinite(amount) ? amount : null,
        note: text(firstOf(offer, ['note', 'requested_note', 'offer_note'])),
        status: (text(offer.status) ?? 'unknown').toLowerCase(),
      } satisfies ShopOffer;
    })
    .filter((offer): offer is ShopOffer => offer !== null)
    /* Only an offer the shop has made and the farmer has not answered is
       actionable; the rest are history the thread's messages already tell. */
    .filter((offer) => offer.status === 'offered' || offer.status === 'pending');

  const visits = (Array.isArray(firstOf(row, ['visits', 'visit_requests']))
    ? (firstOf(row, ['visits', 'visit_requests']) as unknown[])
    : []
  )
    .map((entry) => {
      const visit = record(entry);
      const id = text(visit.id);
      if (!id) return null;
      return {
        id,
        purpose: text(visit.purpose),
        window: text(firstOf(visit, ['window', 'preferred_window', 'scheduled_for', 'day'])),
        status: (text(visit.status) ?? 'unknown').toLowerCase(),
      } satisfies ShopVisit;
    })
    .filter((visit): visit is ShopVisit => visit !== null);

  return {
    shopName: text(firstOf(row, ['shop_name', 'shopName'])) ?? text(shop.name),
    shopPhone: text(firstOf(row, ['shop_phone', 'phone'])) ?? text(shop.phone),
    messages,
    offers,
    visits,
  };
}

/** `farmer_api_notifications` — the shop's outbox, newest first. */
export function normaliseNotifications(value: unknown): ShopNotification[] {
  const rows = Array.isArray(value) ? value : Array.isArray(firstOf(record(value), ['notifications'])) ? (firstOf(record(value), ['notifications']) as unknown[]) : [];
  return rows
    .map((entry) => {
      const row = record(entry);
      const id = text(row.id);
      if (!id) return null;
      return {
        id,
        kind: (text(row.kind) ?? 'message').toLowerCase(),
        title: text(row.title) ?? '',
        body: text(row.body) ?? '',
        createdAt: text(firstOf(row, ['created_at', 'createdAt'])),
      } satisfies ShopNotification;
    })
    .filter((entry): entry is ShopNotification => entry !== null);
}
