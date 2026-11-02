/**
 * The farmer's conversations with dealers, as data.
 *
 * Same split as the community feed: this file is a plain structure with pure
 * functions over it, and `ChatProvider` is the thin layer that keeps one of these
 * alive, writes it to the phone and reads it back. What that buys is a chat that
 * survives a reload — an earlier version kept the threads in `App`'s own state,
 * so every message a farmer sent disappeared the moment the app was reopened,
 * which is the one thing a messaging feature cannot do.
 *
 * Two things are deliberately *not* here:
 *
 *  · the open thread. Which conversation is on screen is where the farmer is
 *    standing, not something to find again three days later.
 *  · a thread's author name. Threads are keyed by the dealer's id, and the
 *    translated name comes from the catalogue at render time, so one conversation
 *    is one conversation in either language.
 */

import { THREAD_META, type ChatMessage, type Threads } from '@/data/chat';

export type ChatState = {
  threads: Threads;
  /** Messages waiting to be read, per thread. Cleared by opening the thread. */
  unread: Record<string, number>;
};

/**
 * A farmer starts with no conversations.
 *
 * This used to start from demo threads, with unread badges, so the chat screen
 * would not open empty — and that was wrong in the way that matters most on a
 * shared phone: after the previous farmer signed out, the next person saw a
 * dealer conversation they had never had and could not tell it was a fixture.
 * A conversation is private correspondence; it exists when the farmer writes to
 * a dealer, and not before. The empty state is the honest first launch.
 */
export function createState(): ChatState {
  return { threads: {}, unread: {} };
}

export function messagesIn(state: ChatState, dealerId: string): ChatMessage[] {
  return state.threads[dealerId] ?? [];
}

export function lastMessage(messages: readonly ChatMessage[]): ChatMessage | undefined {
  return messages[messages.length - 1];
}

/**
 * The list's order: the conversations the app knows about, in the order the design
 * puts them, then anything else the farmer has started.
 *
 * A conversation is a row only once it has messages. An empty array under a
 * dealer's id is not a conversation — it is where somebody once looked — and
 * listing it would tell the next person on this phone which shop the previous
 * one browsed to, as well as showing a row that opens onto nothing.
 *
 * Deliberately not sorted by recency. A row is a person the farmer talks to, and a
 * list that reorders itself while they are reaching for a row is how they end up
 * opening the wrong one.
 */
export function threadKeys(state: ChatState): string[] {
  const spoken = (dealerId: string) => messagesIn(state, dealerId).length > 0;
  const known = Object.keys(THREAD_META).filter(
    (dealerId) => dealerId in state.threads && spoken(dealerId),
  );
  const rest = Object.keys(state.threads).filter(
    (dealerId) => !(dealerId in THREAD_META) && spoken(dealerId),
  );
  return [...known, ...rest];
}

/** How many unread messages a thread holds. */
export function unreadFor(state: ChatState, dealerId: string): number {
  return state.unread[dealerId] ?? 0;
}

export function unreadTotal(state: ChatState): number {
  return Object.values(state.unread).reduce((sum, count) => sum + count, 0);
}

/**
 * Open a conversation: whatever was waiting has now been read.
 *
 * Opening does not create the thread. A conversation comes into existence when a
 * message is sent, which is the only thing that makes one; a shop the farmer
 * merely looked at is not a conversation and must not become a row on this
 * phone. The thread view still renders — against an empty list — so a farmer who
 * opens a shop to write to them gets the composer, which is where they are
 * going.
 */
export function openThread(state: ChatState, dealerId: string): ChatState {
  const read = unreadFor(state, dealerId) === 0 ? state.unread : { ...state.unread, [dealerId]: 0 };
  return read === state.unread ? state : { ...state, unread: read };
}

/** Mark a thread read without opening it — used when a message is sent to it. */
export function markRead(state: ChatState, dealerId: string): ChatState {
  if (unreadFor(state, dealerId) === 0) return state;
  return { ...state, unread: { ...state.unread, [dealerId]: 0 } };
}

/**
 * The farmer's own message, appended to the conversation.
 *
 * Returns the state untouched for an empty send: the screen already disables its
 * send control on an empty box, and a store that invents a message for whitespace
 * would be the second line of defence failing open.
 */
export function sendMessage(
  state: ChatState,
  dealerId: string,
  text: string,
  now: number,
): { state: ChatState; sent: boolean } {
  const body = text.trim();
  if (!body) return { state, sent: false };

  const thread = messagesIn(state, dealerId);
  const id = Math.max(now, ...thread.map((message) => message.id)) + 1;

  return {
    state: {
      ...markRead(state, dealerId),
      threads: {
        ...state.threads,
        [dealerId]: [...thread, { id, from: 'me', text: body }],
      },
    },
    sent: true,
  };
}

// ── what survives a reload ──────────────────────────────────────────────────

export const CHAT_STORAGE_VERSION = 1;

type Persisted = {
  version: number;
  threads: Threads;
  unread: Record<string, number>;
};

export function serialise(state: ChatState): string {
  const payload: Persisted = {
    version: CHAT_STORAGE_VERSION,
    threads: state.threads,
    unread: state.unread,
  };
  return JSON.stringify(payload);
}

function reviveMessage(value: unknown): ChatMessage | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== 'number') return null;
  if (entry.from !== 'me' && entry.from !== 'dealer') return null;

  /* A message is either text the farmer typed or a catalogue line that came in —
     never both, and never neither, or the bubble renders empty. */
  if (typeof entry.text === 'string' && entry.text.trim()) {
    return { id: entry.id, from: entry.from, text: entry.text };
  }
  if (typeof entry.key === 'string') {
    return { id: entry.id, from: entry.from, key: entry.key as ChatMessage['key'] };
  }
  return null;
}

/**
 * Read the phone's copy back.
 *
 * Strict, like the feed: half a conversation — a reply whose question is gone, a
 * thread that lost its last message — reads as the dealer having said something
 * different from what they said. A document that does not fully parse is thrown
 * away and the conversations are rebuilt, because a wrong history in a chat is
 * indistinguishable from a real one.
 */
export function hydrate(raw: string | null): ChatState | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const payload = parsed as Partial<Persisted>;
  if (payload.version !== CHAT_STORAGE_VERSION) return null;
  if (!payload.threads || typeof payload.threads !== 'object') return null;

  const threads: Threads = {};
  for (const [dealerId, list] of Object.entries(payload.threads)) {
    if (!Array.isArray(list)) return null;
    const revived = list.map(reviveMessage);
    if (revived.some((message) => message === null)) return null;
    threads[dealerId] = revived as ChatMessage[];
  }

  const unread: Record<string, number> = {};
  for (const [dealerId, count] of Object.entries(payload.unread ?? {})) {
    if (typeof count !== 'number' || count < 0) return null;
    unread[dealerId] = count;
  }

  return { threads, unread };
}
