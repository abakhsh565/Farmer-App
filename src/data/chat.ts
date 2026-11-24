import type { MessageKey } from '@/i18n/catalog';

/**
 * A thread is keyed by the dealer's name *key*, not by an English string — so a
 * conversation survives a language switch instead of forking into two threads.
 *
 * Messages store a catalog key rather than resolved text for the same reason:
 * switching to Urdu re-renders the history in Urdu, which is what a bilingual
 * user expects.
 */
/**
 * A voice note attached to a message.
 *
 * `url` is a short-lived signed URL from the shop backend and is normally `null`: the
 * shop mints links that live sixty seconds, so one is asked for when the farmer
 * presses play and never kept in a message. `serverId` is the message's id on the
 * shop's side, which is what that link is minted for. `status` is meaningful only
 * for a note this phone is still delivering; a note read from the thread is `sent`.
 */
export type ChatAudio = {
  url: string | null;
  durationMs: number;
  mimeType?: string | null;
  status?: 'sending' | 'failed' | 'sent';
  /** 0…1 while `status` is `sending`. */
  progress?: number;
  /** Stable local id, so a retry reuses the same bubble rather than adding one. */
  localId?: string;
  /** The shop's object path, kept so a failed send can be retried. */
  path?: string | null;
  /** The message's id on the shop's side, for minting a playback link. */
  serverId?: string | null;
};

/**
 * A photo attached to a message.
 *
 * Same shape of life as a voice note: a link is minted on demand, and a photo this
 * phone is still sending is drawn from its own bytes (`localBlob`) so the farmer
 * sees what they picked next to the progress. `width`/`height` let the bubble hold
 * the right space before the picture arrives, so the thread does not jump.
 */
export type ChatImage = {
  url: string | null;
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
  status?: 'sending' | 'failed' | 'sent';
  progress?: number;
  localId?: string;
  path?: string | null;
  serverId?: string | null;
  /** The bytes of a photo that has not reached the shop yet. */
  localBlob?: Blob;
};

export type ChatMessage = {
  id: number;
  from: 'me' | 'dealer';
  /** Catalog key for seeded messages; absent once the user types freely. */
  key?: MessageKey;
  /** Free text the user typed, used instead of `key` when present. */
  text?: string;
  /** Present on a voice message; `text` may then be empty. */
  audio?: ChatAudio;
  /** Present on a photo; `text` carries its caption when there is one. */
  image?: ChatImage;
};

export type Threads = Record<string, ChatMessage[]>;

/**
 * The conversation with real history behind it.
 *
 * The list shows each thread's *last* message, so a thread has to end on the line
 * the design puts in the list — a hand-written preview that is not the newest
 * message would make the list disagree with the conversation behind it the moment
 * anyone opened one. `chat.preview.ali` is therefore both the list line and the
 * final bubble, and the two dealer messages at the end are the two unread ones:
 * the badge on the list is counted from the thread rather than typed into the
 * screen, so it stays true when the farmer reads it.
 */
const ALI: ChatMessage[] = [
  { id: 1, from: 'me', key: 'chat.msg1' },
  { id: 2, from: 'dealer', key: 'chat.msg2' },
  { id: 3, from: 'dealer', key: 'chat.preview.ali' },
];

const GREEN: ChatMessage[] = [{ id: 1, from: 'dealer', key: 'chat.preview.greenAgro' }];
const WAZIRABAD: ChatMessage[] = [{ id: 1, from: 'dealer', key: 'chat.preview.wazirabad' }];
const MALIK: ChatMessage[] = [{ id: 1, from: 'dealer', key: 'chat.preview.malik' }];

export const SEED_THREAD: ChatMessage[] = ALI;

/**
 * Conversations exist from the first launch. A chat screen that opens empty reads
 * as a broken feature rather than an unstarted one, and a farmer who has been
 * buying from the same dealer for years always has history. New threads are still
 * created by messaging a dealer, and the empty state is still a real state the
 * screen renders — it is just not the default one.
 */
export const SEED_THREADS: Threads = {
  'dealer.aliTraders': ALI,
  'dealer.greenAgro': GREEN,
  'dealer.wazirabadAgri': WAZIRABAD,
  'dealer.malikFertilizers': MALIK,
};

export type ThreadMeta = {
  timeKey: MessageKey;
  unread?: number;
  /** A shop that is shut is drawn dimmed in the list, as it is on the Dealers screen. */
  muted?: boolean;
};

/**
 * List-level facts that are not part of the messages themselves: when the thread
 * was last touched, whether anything is waiting to be read, and whether the
 * dealer's shop is currently open.
 *
 * Display order is this object's key order, so the most recent conversation is
 * written first rather than sorted by a timestamp the demo data does not carry.
 * `unread` counts the trailing dealer messages — it is the same number the thread
 * view renders, not a decoration of the list.
 */
export const THREAD_META: Record<string, ThreadMeta> = {
  'dealer.aliTraders': { timeKey: 'chat.time.10min', unread: 2 },
  'dealer.greenAgro': { timeKey: 'chat.time.2h' },
  'dealer.wazirabadAgri': { timeKey: 'chat.time.yesterday' },
  'dealer.malikFertilizers': { timeKey: 'chat.time.mon', muted: true },
};
