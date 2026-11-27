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
 * guess: when the shop backend is configured the conversations *are* the shop's
 * threads, read and written through `farmer_api_*`; when it is not, the app keeps
 * the on-device conversation it has always had. The screens ask the same questions
 * either way — which conversations exist, what was said, what is unread — so the
 * chat screen did not have to learn a second vocabulary.
 *
 * The live source wins outright rather than merging with the local store, because
 * merging would invent a history: the shop's thread is the record of what was
 * actually said, and a bubble from the old local store has no sender on the shop's
 * side to confirm it.
 *
 * The list is a fact about the *account*. The live side reads every dealer this
 * farmer has opened from the shop network (`farmer_api_shops` → linked shops), and
 * each thread with it, so moving city, changing the searched area or opening a
 * different branch does not remove a conversation from the Chat tab. The local
 * side is the same: a document keyed by the signed-in owner.
 */

export type ChatStatus = 'loading' | 'ready' | 'error';

/**
 * One dealer conversation, as the Chat tab lists it.
 *
 * `lastMessage` is the newest line, and `unread` counts the dealer's messages the
 * farmer has not read. Both are computed where the truth is — the local store for
 * the on-device source, the shop's threads and outbox for the live one — rather
 * than typed into the screen.
 */
export type ChatConversation = {
  dealerId: string;
  /** Empty on the live source only if the shop named itself nowhere. */
  name: string;
  phone: string | null;
  messages: ChatMessage[];
  lastMessage: ChatMessage | null;
  /** When the newest line was written, ISO, or `null` for a conversation with none. */
  lastAt: string | null;
  unread: number;
};

type ChatValue = {
  status: ChatStatus;
  /** A storage read that failed outright — the one thing the screen cannot absorb. */
  retry: () => void;
  /** True while anything written here is still waiting for the backend. */
  pending: number;
  online: boolean;
  /** Every conversation, newest activity first. */
  conversations: ChatConversation[];
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
   * The live conversations are the shop network's, and there is one per dealer the
   * farmer has opened. `null` while the credential is being read is honest — there
   * is no conversation to show yet, and inventing an id would list a conversation
   * with no name.
   */
  const live = shop.configured;
  /* The shop the open thread belongs to: whichever shop the farmer opened from the
     dealer's list, or the one the invitation named. */
  const liveDealerId = live ? (shop.activeShopId ?? shop.credential?.shopId ?? null) : null;

  const value = useMemo<ChatValue>(() => {
    const openThread = (dealerId: string) => {
      if (live) {
        /* Reading a conversation is what makes its badge true, and on the live
           source the badge is counted from the shop's outbox. Only this
           conversation's notices are cleared. */
        shop.markNotificationsRead(dealerId);
      } else {
        setState((current) => openThreadIn(current, dealerId));
      }
      setOpenThreadKey(dealerId);
    };

    /*
     * Files still on their way to the shop, drawn at the end of the conversation
     * they belong to as the farmer's own bubbles.
     *
     * They are not part of the thread on purpose: that is the shop's record of what
     * it received, and a note that is still uploading is not part of it. Each item
     * names its shop, so a file does not appear in whichever conversation is open
     * when it finishes — or starts.
     */
    const outboxFor = (shopId: string | null): ChatMessage[] =>
      shop.mediaOutbox
        .filter((item) => (item.shopId ?? liveDealerId) === shopId)
        .map((item, index) => ({
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
      const conversations: ChatConversation[] = shop.conversations.map((conversation) => {
        const messages = [...conversation.messages, ...outboxFor(conversation.shopId)];
        const lastMessage = messages[messages.length - 1] ?? null;
        return {
          dealerId: conversation.shopId,
          name: conversation.name,
          phone: conversation.phone,
          messages,
          lastMessage,
          lastAt: lastMessage?.sentAt ?? conversation.lastAt,
          unread: conversation.unread,
        };
      });

      return {
        status: shop.status === 'loading' ? 'loading' : 'ready',
        retry: () => void shop.refresh(),
        pending: shop.busy ? 1 : 0,
        online,
        conversations,
        threadKeys: conversations.map((conversation) => conversation.dealerId),
        messages: (dealerId) =>
          conversations.find((conversation) => conversation.dealerId === dealerId)?.messages ?? [],
        unread: (dealerId) =>
          conversations.find((conversation) => conversation.dealerId === dealerId)?.unread ?? 0,
        unreadTotal: conversations.reduce((total, conversation) => total + conversation.unread, 0),
        openThreadKey,
        openThread,
        closeThread: () => setOpenThreadKey(null),
        /*
         * Sent, not queued. The screen clears the box because the shop accepted the
         * message; a bubble that never reached the shop and still looked sent is the
         * one failure a chat must not have. The refresh below is what draws it.
         */
        send: (dealerId, text) => {
          const body = text.trim();
          if (!body) return false;
          void shop.send(body, dealerId);
          return true;
        },
        live: true,
      };
    }

    const status: ChatStatus =
      document.status === 'loading' ? 'loading' : document.status === 'error' ? 'error' : 'ready';

    const conversations: ChatConversation[] = threadKeys(state).map((dealerId) => {
      const messages = messagesIn(state, dealerId);
      return {
        dealerId,
        name: '',
        phone: null,
        messages,
        lastMessage: messages[messages.length - 1] ?? null,
        lastAt: null,
        unread: unreadFor(state, dealerId),
      };
    });

    return {
      status,
      retry: document.reload,
      pending: document.pending,
      online,
      conversations,
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
