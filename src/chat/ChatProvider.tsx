import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { ChatMessage } from '@/data/chat';
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
 * Holds one `ChatState`, and the one piece of navigation that goes with it: which
 * conversation is open.
 *
 * It sits above the screens so that opening a dealer from the Home card, from the
 * dealers list or from the chat list is one destination rather than three copies,
 * and so the conversation is the same object whichever door the farmer came
 * through. Being on the service layer is what makes the history durable: the
 * threads are a document like the credit requests and the feed, written through
 * the repository, so they are still there after a reload.
 *
 * Ownership follows the gate that already exists: sending a message asks for an
 * account, so the document belongs to the account once there is one — and a
 * conversation started before signing in migrates with it rather than being left
 * behind.
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
};

const ChatContext = createContext<ChatValue | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const { account } = useSession();
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

  /*
   * Where the farmer is standing, not what they have said — so it is React state
   * rather than part of the document. Reopening the app lands on the chat list,
   * which is where a moment's thought would expect to be.
   */
  const [openThreadKey, setOpenThreadKey] = useState<string | null>(null);

  const status: ChatStatus =
    document.status === 'loading' ? 'loading' : document.status === 'error' ? 'error' : 'ready';

  const value = useMemo<ChatValue>(
    () => ({
      status,
      retry: document.reload,
      pending: document.pending,
      online,
      threadKeys: threadKeys(state),
      messages: (dealerId) => messagesIn(state, dealerId),
      unread: (dealerId) => unreadFor(state, dealerId),
      unreadTotal: unreadTotal(state),
      openThreadKey,
      openThread: (dealerId) => {
        setState((current) => openThreadIn(current, dealerId));
        setOpenThreadKey(dealerId);
      },
      closeThread: () => setOpenThreadKey(null),
      send: (dealerId, text) => {
        const { state: next, sent } = sendMessage(state, dealerId, text, Date.now());
        if (sent) setState(next);
        return sent;
      },
    }),
    [state, status, online, openThreadKey, document.reload, document.pending, setState],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat() {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error('useChat must be used inside a ChatProvider');
  }
  return context;
}
