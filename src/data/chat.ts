import type { MessageKey } from '@/i18n/catalog';

/**
 * A thread is keyed by the dealer's name *key*, not by an English string — so a
 * conversation survives a language switch instead of forking into two threads.
 *
 * Messages store a catalog key rather than resolved text for the same reason:
 * switching to Urdu re-renders the history in Urdu, which is what a bilingual
 * user expects.
 */
export type ChatMessage = {
  id: number;
  from: 'me' | 'dealer';
  /** Catalog key for seeded messages; absent once the user types freely. */
  key?: MessageKey;
  /** Free text the user typed, used instead of `key` when present. */
  text?: string;
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
