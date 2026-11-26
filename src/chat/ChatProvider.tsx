import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { ChatMessage } from '@/data/chat';
import { useShopApi } from '@/shop/ShopApiProvider';
import { ownerFor, useOnline, usePersistentDocument } from '@/services/persistence';
import { useSession } from '@/session/SessionProvider';
import {
  createState,
  hydrate,
  messagesIn,
  openThread as openThreadIn,
  sendMessage,
  serialise,
  threadKeys,
  unreadFor,
  unreadTotal,
  type ChatState,
} from './store';

/**
 * The farmer's conversations.
 *
 * Two sources behind one interface, and which one you get is a build fact, not a
 * guess: when the shop backend is configured the conversation *is* the shop's
 * thread, read and written through `farmer_api_*`; when it is not, the app keeps
 * the on-device conversation it has always had. The screens ask the same questions
 * either way — which conversations exist, what was said, what is unread — so the
 * chat screen did not have to learn a second vocabulary.
 *
 * The live source wins outright rather than merging with the local store, because
 * merging would invent a history: the shop's thread is the record of what was
 * actually said, and a bubble from the old local store has no sender on the shop's
 * side to confirm it.
 *
 * `openThreadKey` stays here even though the live case has exactly one thread: it
 * is where the farmer is standing, it is what a notification tap sets, and the
 * screen's back button reads it.
 */

export type ChatStatus = 'loading' | 'ready' | 'error';

type ChatValue = {
  status: ChatStatus;
  /** A storage read that failed outright — the one thing the screen cannot absorb. */
  retry: () => void;
  /** True while anything written here is still waiting for the backend. */
  pending: number;
  online: boolean;
  /** The dealer ids with a conversation, in the order the list shows them. */
  threadKeys: string[];
  messages: (dealerId: string) => ChatMessage[];
  unread: (dealerId: string) => number;
  unreadTotal: number;
  openThreadKey: string | null;
  openThread: (dealerId: string) => void;
  closeThread: () => void;
  send: (dealerId: string, text: string) => boolean;
  /** True when the conversation is the shop's own thread rather than this phone's. */
  live: boolean;
};

const ChatContext = createContext<ChatValue | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const { account } = useSession();
  const shop = useShopApi();
  const ownerId = useMemo(() => ownerFor(account?.id ?? null), [account?.id]);
  const document = usePersistentDocument<ChatState>({
    collection: 'chat',
    ownerId,
    seed: createState,
    hydrate,
    serialise,
  });
  const { data: state, setData: setState } = document;
  const online = useOnline();

  const [openThreadKey, setOpenThreadKey] = useState<string | null>(null);

  /*
   * The live conversation is the shop's, and there is exactly one of them: the
   * credential names the pair (farmer, shop). `null` while the credential is being
   * read is honest — there is no shop to show yet, and inventing an id would list a
   * conversation with no name.
   */
  const live = shop.configured;
  /* The shop the thread belongs to: whichever shop the farmer opened from the
     dealer's list, or the one the invitation named. */
  const liveDealerId = live ? (shop.activeShopId ?? shop.credential?.shopId ?? null) : null;

  const value = useMemo<ChatValue>(() => {
    const openThread = (dealerId: string) => {
      if (live) {
        /* Reading the thread is what makes the badge true, and on the live source
           the badge is counted from the shop's outbox. */
        shop.markNotificationsRead();
      } else {
        setState((current) => openThreadIn(current, dealerId));
      }
      setOpenThreadKey(dealerId);
    };

    /*
     * Files still on their way to the shop, drawn at the end of the thread as the
     * farmer's own bubbles.
     *
     * They are not part of `shop.thread` on purpose: that is the shop's record of what
     * it received, and a note that is still uploading is not part of it. Drawing them
     * here is what lets the farmer see progress and a retry without the screen needing
     * a second kind of message list.
     */
    const outboxMessages: ChatMessage[] = shop.mediaOutbox.map((item, index) => ({
      id: 1_000_000 + index,
      from: 'me' as const,
      ...(item.kind === 'voice'
        ? {
            audio: {
              url: null,
              durationMs: item.durationMs,
              mimeType: item.mimeType,
              status: item.status,
              progress: item.progress,
              localId: item.localId,
            },
          }
        : {
            image: {
              url: null,
              mimeType: item.mimeType,
              status: item.status,
              progress: item.progress,
              localId: item.localId,
              /* The picture is drawn from these bytes until the shop has it, so the
                 farmer sees the photo they picked rather than a placeholder. */
              localBlob: item.blob,
            },
          }),
    }));

    if (live) {
      return {
        status: shop.status === 'loading' ? 'loading' : 'ready',
        retry: () => void shop.refresh(),
        pending: shop.busy ? 1 : 0,
        online,
        threadKeys: liveDealerId ? [liveDealerId] : [],
        messages: (dealerId) =>
          dealerId === liveDealerId ? [...(shop.thread?.messages ?? []), ...outboxMessages] : [],
        unread: (dealerId) => (dealerId === liveDealerId ? shop.unread : 0),
        unreadTotal: shop.unread,
        openThreadKey,
        openThread,
        closeThread: () => setOpenThreadKey(null),
        /*
         * Sent, not queued. The screen clears the box because the shop accepted the
         * message; a bubble that never reached the shop and still looked sent is the
         * one failure a chat must not have. The refresh below is what draws it.
         */
        send: (_dealerId, text) => {
          const body = text.trim();
          if (!body) return false;
          void shop.send(body);
          return true;
        },
        live: true,
      };
    }

    const status: ChatStatus =
      document.status === 'loading' ? 'loading' : document.status === 'error' ? 'error' : 'ready';

    return {
      status,
      retry: document.reload,
      pending: document.pending,
      online,
      threadKeys: threadKeys(state),
      messages: (dealerId) => messagesIn(state, dealerId),
      unread: (dealerId) => unreadFor(state, dealerId),
      unreadTotal: unreadTotal(state),
      openThreadKey,
      openThread,
      closeThread: () => setOpenThreadKey(null),
      send: (dealerId, text) => {
        const { state: next, sent } = sendMessage(state, dealerId, text, Date.now());
        if (sent) setState(next);
        return sent;
      },
      live: false,
    };
  }, [
    document.pending,
    document.reload,
    document.status,
    live,
    liveDealerId,
    online,
    openThreadKey,
    setState,
    shop,
    state,
  ]);

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat() {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error('useChat must be used inside a ChatProvider');
  }
  return context;
}
