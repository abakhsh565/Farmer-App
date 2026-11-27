import { Capacitor } from '@capacitor/core';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { serviceConfig } from '@/services/config';
import type { ChatMessage } from '@/data/chat';
import {
  mediaCapability,
  mediaLink,
  fetchShopMedia,
  sendAttachment,
  uploadMedia,
  validateMedia,
  type MediaKind,
} from './api/media';
import { toE164 } from '@/services/supabaseClient';
import { useSession } from '@/session/SessionProvider';
import {
  farmerAnswerOffer,
  farmerCreateCreditRequest,
  farmerJoinShop,
  farmerMe,
  farmerNotifications,
  farmerContactShop,
  farmerRequestVisit,
  farmerSendMessage,
  farmerShops,
  farmerThread,
  isTerminal,
  type FarmerIdentity,
  type ShopApiFailure,
} from './api/client';
import {
  clearShopCredential,
  loadShopCredential,
  saveShopCredential,
  type ShopCredential,
} from './api/credential';
import {
  clearAccountCredential,
  loadAccountCredential,
  saveAccountCredential,
} from './api/credentialSync';
import { alertDealerReply } from '@/services/dealerAlerts';
import { parseShopLink } from './api/deepLink';
import { subscribeShopTopic } from './api/realtime';
import {
  firstRow,
  normaliseMe,
  normaliseNotifications,
  normaliseShops,
  normaliseThread,
  type ShopMe,
  type ShopNotification,
  type ShopSummary,
  type ShopThread,
} from './api/types';

/**
 * The shop, as this app knows it.
 *
 * One credential, one shop, one conversation. That is the whole shape of the
 * integration, and it is why this provider can be this small: there is no shop
 * picker and no per-shop thread map, because a farmer's credential *is* the pair
 * (farmer, shop). The local chat store this replaces was keyed by dealer because
 * it was pretending to be many conversations; the real one is exactly one.
 *
 * Three rules it enforces, each for a reason:
 *
 *  · **Pull on open.** Push is best-effort; the thread is the truth. Every launch
 *    and every return to the foreground re-reads the thread and the outbox, so a
 *    farmer with notifications switched off still sees the conversation.
 *  · **A link is an invitation, not a login.** Both deep-link kinds land in the
 *    same place, and neither writes a credential until the shop's own `me` call
 *    has confirmed who it belongs to.
 *  · **NOT_AUTHORIZED is terminal.** It means the owner re-issued or revoked the
 *    credential; keeping it would mean a chat that writes into nothing.
 */

export type ShopApiStatus =
  /** No shop backend in this build: the app keeps its on-device conversation. */
  | 'unconfigured'
  /** Configured, but this phone has not joined a shop yet. */
  | 'no-credential'
  | 'loading'
  /** Connected: the thread below is live. */
  | 'ready'
  /** The stored credential is gone. */
  | 'expired'
  | 'error';

export type ShopFailure = { kind: ShopApiFailure; message: string } | null;

/**
 * A file this phone is still delivering — a voice note or a photo.
 *
 * The bytes live here, not in the thread, because the thread is the shop's record of
 * what was said and a file that has not arrived is not part of it yet. Keeping it out
 * of `thread` is also what makes retry honest: the bubble shows the recording or
 * picture it will actually re-send, with progress and a failure it can recover from.
 *
 * `storagePath` is written as soon as the bytes are stored, so a failure at the
 * second step (recording the message) is retried without uploading them again.
 */
export type MediaOutboxItem = {
  localId: string;
  /** The shop this file is for, so switching conversations cannot show it in the wrong one. */
  shopId: string | null;
  kind: MediaKind;
  blob: Blob;
  mimeType: string;
  /** `0` for a photo: the shop refuses a duration on an image. */
  durationMs: number;
  storagePath: string | null;
  status: 'sending' | 'failed';
  /** 0…1 while uploading. */
  progress: number;
  error: string | null;
};

/**
 * One dealer conversation, as the Chat tab lists it.
 *
 * Every shop this farmer has opened is here — not only the one the credential was
 * minted for, and not only the ones near the farmer today. The list is a fact about
 * the account at the shop network, which is why it survives a change of city, a
 * branch switch or a reinstall: it is read from `farmer_api_shops`, not from the
 * nearby-dealer search.
 */
export type ShopConversation = {
  shopId: string;
  name: string;
  phone: string | null;
  messages: ChatMessage[];
  lastMessage: ChatMessage | null;
  /** When the newest line was written, ISO. `null` for a conversation with none. */
  lastAt: string | null;
  unread: number;
};

type ShopApiValue = {
  status: ShopApiStatus;
  configured: boolean;
  credential: ShopCredential | null;
  me: ShopMe | null;
  /** The active conversation's thread. */
  thread: ShopThread | null;
  /** Every loaded conversation, keyed by shop id. */
  threads: Record<string, ShopThread>;
  /** Every dealer conversation the farmer has, newest first. */
  conversations: ShopConversation[];
  /** The shops the dealer platform lists for this farmer, connected or not. */
  shops: ShopSummary[];
  /** The shop whose conversation `thread` holds; null means the credential's shop. */
  activeShopId: string | null;
  /** Opens (and reads) the conversation with one shop from the dealer's list. */
  openShopConversation: (shopId: string) => Promise<boolean>;
  notifications: ShopNotification[];
  unread: number;
  busy: boolean;
  failure: ShopFailure;
  joinWithCode: (code: string) => Promise<boolean>;
  joinWithLink: (link: string) => Promise<boolean>;
  forget: () => void;
  /**
   * Writes one line into a shop's thread.
   *
   * The shop is named explicitly because the screen can show one shop while the
   * credential still belongs to another: without it the message went to whichever
   * shop was opened last, which is not the one the farmer is looking at.
   */
  send: (text: string, shopId?: string | null) => Promise<boolean>;
  /** True once the shop backend has answered the media contract — voice and photos. */
  mediaSupported: boolean;
  /** Files on their way to the shop, newest last. */
  mediaOutbox: MediaOutboxItem[];
  sendMedia: (file: { kind: MediaKind; blob: Blob; mimeType: string; durationMs?: number }) => Promise<boolean>;
  retryMedia: (localId: string) => Promise<boolean>;
  discardMedia: (localId: string) => void;
  /** A fresh sixty-second link for one message's file, or `null` when it cannot be made. */
  resolveMediaUrl: (serverId: string | null | undefined) => Promise<string | null>;
  askCredit: (amount: number, note: string | null) => Promise<boolean>;
  askVisit: (purpose: string | null, window: string | null) => Promise<boolean>;
  answerOffer: (requestId: string, accept: boolean, note: string | null) => Promise<boolean>;
  refresh: () => Promise<void>;
  /** Marks one conversation's notices read; no argument marks all of them. */
  markNotificationsRead: (shopId?: string) => void;
  /** The notices the farmer has already seen, so the badge counts something real. */
  seenNotificationIds: string[];
};

const ShopApiContext = createContext<ShopApiValue | null>(null);

const SEEN_KEY = 'farmer.shop.notifications.seen';
/**
 * How many conversations are read on one refresh.
 *
 * The dealer platform lists up to 500 shops, but a farmer's opened conversations
 * are a handful. The cap exists so a pathological account cannot make the app open
 * hundreds of sockets' worth of reads on every poll; a conversation beyond it still
 * opens normally when the farmer taps it.
 */
const MAX_CONVERSATIONS = 20;
/**
 * The shop list as it was last seen, so the Shop tab paints shops before the
 * network answers.
 *
 * The dealer platform's `farmer_api_shops` is a cold call over a slow path, and a
 * farmer opening the tab waited for it every time even though the shops change
 * rarely. Reading the last answer first — then replacing it when the fresh one
 * arrives — is the difference between a screen that fills and a screen that
 * spins.
 */
const SHOPS_KEY = 'farmer.shop.cached.shops';

function loadCachedShops(): ShopSummary[] {
  try {
    const raw = localStorage.getItem(SHOPS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed) ? (parsed as ShopSummary[]) : [];
  } catch {
    return [];
  }
}

function saveCachedShops(shops: ShopSummary[]): void {
  try {
    localStorage.setItem(SHOPS_KEY, JSON.stringify(shops.slice(0, 50)));
  } catch {
    // Storage refused: the list is still correct for this session.
  }
}

function loadSeen(): string[] {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function saveSeen(ids: string[]): void {
  try {
    // Bounded: a phone that runs for a year must not accumulate every notice ever.
    localStorage.setItem(SEEN_KEY, JSON.stringify(ids.slice(-200)));
  } catch {
    // Storage refused: the badge over-counts until the app is reopened.
  }
}

export function ShopApiProvider({ children }: { children: ReactNode }) {
  const configured = serviceConfig.shopApi.configured;
  /*
   * The farmer's own identity, for the one call that has to introduce him.
   *
   * Joining is the only place the shop learns who this is, and it learns it the way
   * the owner does at the counter: a name and a phone number. The number is the
   * identity on the shop's side, so it goes as national digits (`92300…`) — the
   * shop normalises its own `0300…` and `+92300…` to the same key.
   */
  const { account } = useSession();
  /* The signed-in account this connection belongs to. A ref, because the calls
     that save a credential outlive the render they were started in. */
  const accountId = useRef<string | null>(null);
  accountId.current = account?.id ?? null;
  const identity = useMemo<FarmerIdentity | null>(() => {
    if (!account?.phone) return null;
    const phone = toE164(account.phone).replace(/^\+/, '');
    if (!phone) return null;
    return { phone, name: account.name.trim() || phone };
  }, [account?.name, account?.phone]);

  const [credential, setCredential] = useState<ShopCredential | null>(() =>
    configured ? loadShopCredential() : null,
  );
  const [status, setStatus] = useState<ShopApiStatus>(
    configured ? (loadShopCredential() ? 'loading' : 'no-credential') : 'unconfigured',
  );
  const [me, setMe] = useState<ShopMe | null>(null);
  /*
   * One thread per dealer the farmer has opened.
   *
   * The provider used to hold exactly one, because one credential named one shop.
   * The dealer platform lists every shop to the same farmer now, and the Chat tab
   * is a list of all of them, so the threads are kept side by side: switching a
   * conversation is a lookup, not a reload, and a reply that arrives in another
   * conversation still updates that conversation's row.
   */
  const [threads, setThreads] = useState<Record<string, ShopThread>>({});
  const [shops, setShops] = useState<ShopSummary[]>(() => (configured ? loadCachedShops() : []));
  /* Which dealer messages this session has already shown. A ref, because the
     comparison happens inside a callback that outlives the render. */
  const knownMessages = useRef<Set<number>>(new Set());
  const baselineSeen = useRef(false);
  /**
   * Which shop's conversation the thread holds. `null` means the shop the
   * credential belongs to, which is every farmer connected to one counter.
   */
  const [activeShopId, setActiveShopId] = useState<string | null>(null);
  const activeShop = useRef<string | null>(null);
  const [notifications, setNotifications] = useState<ShopNotification[]>([]);
  const [failure, setFailure] = useState<ShopFailure>(null);
  const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState<string[]>(loadSeen);
  const [mediaSupported, setMediaSupported] = useState(false);
  const [mediaOutbox, setMediaOutbox] = useState<MediaOutboxItem[]>([]);

  /** The credential as it is *now*, for callbacks that outlive a render. */
  const current = useRef<ShopCredential | null>(credential);
  current.current = credential;

  const expire = useCallback(() => {
    clearShopCredential();
    /* The shop ended the connection, so the account's copy of it must go too —
       otherwise the next device would adopt a credential that no longer opens
       anything. */
    void clearAccountCredential(accountId.current);
    activeShop.current = null;
    setActiveShopId(null);
    setCredential(null);
    setMe(null);
    setThreads({});
    setNotifications([]);
    setStatus('expired');
  }, []);

  /** Reads the thread and the outbox for a credential that is already trusted. */
  const load = useCallback(
    async (token: string): Promise<boolean> => {
      /* The identity first: it names the shop the credential belongs to, which the
         shop-scoped calls below need before they can run. */
      const meResult = await farmerMe(token);

      if (!meResult.ok) {
        if (isTerminal(meResult.error)) {
          expire();
        } else {
          setFailure({ kind: meResult.error, message: meResult.message });
          setStatus('error');
        }
        return false;
      }

      const identity = normaliseMe(meResult.data);
      if (!identity) {
        setFailure({ kind: 'not-found', message: 'The shop did not recognise this credential.' });
        setStatus('error');
        return false;
      }

      setMe(identity);

      /*
       * Name one shop before reading anything shop-scoped.
       *
       * `farmer_api_thread` and `farmer_api_media` answer
       * "VALIDATION: this farmer deals with more than one shop — name the shop"
       * when a farmer is linked to several shops and the call carries no id. A
       * farmer with two counters is not an edge case here, and that refusal used to
       * leave the conversation empty and the microphone hidden — the app looked
       * broken while the backend was answering correctly.
       *
       * The credential's own shop is the natural first conversation; when it is not
       * in the list, the first linked shop is. Nothing is invented: a shop id that
       * the platform did not list is never used.
       */
      const shopsResult = await farmerShops(token);
      const listed = shopsResult.ok ? normaliseShops(shopsResult.data) : [];
      /* A failed listing keeps the shops already on screen, and the cache: a bad
         minute on the platform does not delete a shop that exists. */
      if (shopsResult.ok) {
        setShops(listed);
        saveCachedShops(listed);
      }

      /*
       * The conversations are the shops this farmer has opened with, plus the shop
       * the credential was minted for.
       *
       * A shop the directory lists but the farmer has never written to is
       * discovery, not a conversation: it belongs on the Dealers tab, and opening
       * its chat is what creates the link at the shop's side. Listing all 500
       * directory shops here instead would make the Chat tab a second Dealers tab.
       *
       * The credential's shop comes first, then the platform's order (linked
       * first, by name), so the first open of a fresh install lands on the counter
       * whose invitation this phone holds.
       */
      const linked = listed.filter((shop) => shop.isLinked).map((shop) => shop.shopId);
      const conversationIds = [...new Set([identity.shopId, ...linked])]
        .filter((id): id is string => Boolean(id))
        .slice(0, MAX_CONVERSATIONS);

      let shopId = activeShop.current;
      if (!shopId || !conversationIds.includes(shopId)) {
        shopId = conversationIds[0] ?? null;
        activeShop.current = shopId;
        setActiveShopId(shopId);
      }

      /*
       * Every conversation, read together.
       *
       * Each shop's thread is its own call, so a list of conversations is a list
       * of reads. A thread that fails on its own keeps the copy already on screen:
       * a bad minute on the platform must not blank a conversation the farmer can
       * read, and the next refresh fills it.
       */
      const [threadResults, notificationsResult] = await Promise.all([
        Promise.all(
          conversationIds.map(async (id) => {
            const [threadResult, mediaResult] = await Promise.all([
              farmerThread(token, id),
              fetchShopMedia(token, serviceConfig.shopApi, id),
            ]);
            /* The thread says who said what; the media call says which of those
               messages carry a file and how long it runs. A conversation of plain
               text answers `[]`, and a backend without the call at all is not a
               reason to blank the messages. */
            return threadResult.ok
              ? ([id, normaliseThread(threadResult.data, mediaResult.ok ? mediaResult.data : [])] as const)
              : null;
          }),
        ),
        farmerNotifications(token),
      ]);

      const nextThreads: Record<string, ShopThread> = {};
      for (const entry of threadResults) {
        if (entry) nextThreads[entry[0]] = entry[1];
      }

      setThreads((previous) => {
        const merged: Record<string, ShopThread> = {};
        for (const id of conversationIds) {
          const next = nextThreads[id] ?? previous[id];
          if (next) merged[id] = next;
        }
        return merged;
      });
      setNotifications(notificationsResult.ok ? normaliseNotifications(notificationsResult.data) : []);

      /*
       * A dealer reply that arrived while the farmer was elsewhere.
       *
       * The first successful read is the baseline — a farmer opening the app must
       * not be notified about every message already in the thread. After that, any
       * dealer message this session has not seen is announced through the phone
       * when the page is hidden, which is exactly the case the farmer asked about.
       */
      const dealerMessages = Object.values(nextThreads).flatMap((entry) =>
        entry.messages.filter((message) => message.from === 'dealer'),
      );
      const unseen = dealerMessages.filter((message) => !knownMessages.current.has(message.id));
      for (const message of dealerMessages) knownMessages.current.add(message.id);
      const wasBaseline = baselineSeen.current;
      baselineSeen.current = true;
      const newest = unseen[unseen.length - 1];
      if (
        wasBaseline &&
        newest &&
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden'
      ) {
        void alertDealerReply(identity.shopName || 'Your dealer', newest);
      }

      /* The shop's own name wins over the one stored at join time — a shop may
         rename itself, and the credential is not the place that fact lives. */
      const refreshed: ShopCredential = {
        token,
        farmerId: identity.farmerId,
        shopId: identity.shopId,
        shopName: identity.shopName || current.current?.shopName || '',
        joinedAt: current.current?.joinedAt ?? Date.now(),
      };
      saveShopCredential(refreshed);
      /* And on the account, so a phone, a browser and a replacement phone all
         open the same shops without the code being typed again. */
      void saveAccountCredential(accountId.current, refreshed);
      setCredential(refreshed);
      setFailure(null);
      setStatus('ready');
      return true;
    },
    [expire],
  );

  const refresh = useCallback(async () => {
    const token = current.current?.token;
    if (!configured || !token) return;
    await load(token);
  }, [configured, load]);

  /* Launch, and every return to the foreground: push is best-effort, the thread
     is the truth. */
  useEffect(() => {
    if (!configured) return;

    const local = loadShopCredential();
    if (local) {
      void load(local.token);
      return;
    }

    /*
     * Nothing on this device. The connection may still belong to the account —
     * a farmer who connected in the app on his phone opens the site on a laptop
     * and expects the same shops, not a code prompt. So the account's copy is
     * read once, and only then is the farmer told he is not connected.
     */
    const owner = account?.id;
    if (!owner) {
      setStatus('no-credential');
      return;
    }

    let cancelled = false;
    setStatus('loading');
    void (async () => {
      const saved = await loadAccountCredential(owner);
      if (cancelled || current.current) return;
      if (!saved) {
        setStatus('no-credential');
        return;
      }
      saveShopCredential(saved);
      setCredential(saved);
      await load(saved.token);
    })();

    return () => {
      cancelled = true;
    };
  }, [account?.id, configured, load]);

  useEffect(() => {
    if (!configured || !Capacitor.isNativePlatform()) return;
    let remove: (() => void) | undefined;

    void (async () => {
      try {
        const { App } = await import('@capacitor/app');
        const listener = await App.addListener('appStateChange', ({ isActive }) => {
          if (isActive && current.current) void refresh();
        });
        remove = () => void listener.remove();
      } catch {
        // No App plugin (an older shell): the launch read still happened.
      }
    })();

    return () => remove?.();
  }, [configured, refresh]);

  /**
   * Adopts a token only after the shop has said whose it is.
   *
   * This is the one place a credential is written from outside, and the `me` call
   * is why: a token pasted into a chat, forwarded on WhatsApp or left in a link
   * that has expired resolves to nothing, and writing it first would leave the app
   * holding a key to no door.
   */
  const adopt = useCallback(
    async (token: string): Promise<boolean> => {
      if (!configured) {
        setFailure({ kind: 'unconfigured', message: 'This build has no shop backend.' });
        return false;
      }

      setBusy(true);
      setStatus('loading');
      try {
        const result = await farmerMe(token);
        if (!result.ok) {
          setFailure({ kind: result.error, message: result.message });
          setStatus(result.error === 'unconfigured' ? 'unconfigured' : 'no-credential');
          return false;
        }

        const me = normaliseMe(result.data);
        if (!me) {
          setFailure({ kind: 'not-found', message: 'This invitation is not recognised by the shop.' });
          setStatus('no-credential');
          return false;
        }

        const next: ShopCredential = {
          token,
          farmerId: me.farmerId,
          shopId: me.shopId,
          shopName: me.shopName,
          joinedAt: Date.now(),
        };
        saveShopCredential(next);
        void saveAccountCredential(accountId.current, next);
        /* A new credential is a new set of shops, so the reading goes back to the
           shop the invitation names. */
        activeShop.current = null;
        setActiveShopId(null);
        setCredential(next);
        return await load(token);
      } finally {
        setBusy(false);
      }
    },
    [configured, load],
  );

  const joinWithCode = useCallback(
    async (code: string): Promise<boolean> => {
      if (!configured) return false;
      setBusy(true);
      setFailure(null);
      try {
        /* A phone number is what the shop records, so a build that let an account
           without one try to join would ask the owner to accept a nameless farmer. */
        if (!identity) {
          setFailure({
            kind: 'validation',
            message: 'Connecting to a shop needs a phone number on this account.',
          });
          return false;
        }

        const result = await farmerJoinShop(code, identity);
        if (!result.ok) {
          setFailure({ kind: result.error, message: result.message });
          return false;
        }

        const row = firstRow(result.data) ?? {};
        const token = typeof row.token === 'string' ? row.token : null;

        /* A second join with the same code returns `token: null` with
           `already_connected: true`. That is a success, and it must not overwrite
           the credential that already works. */
        if (!token) {
          const existing = current.current;
          if (existing) return await load(existing.token);
          setFailure({
            kind: 'not-found',
            message: 'The shop says you are connected, but this phone has no invitation. Ask the shop to send one.',
          });
          return false;
        }

        return await adopt(token);
      } finally {
        setBusy(false);
      }
    },
    [adopt, configured, identity, load],
  );

  /**
   * Does this shop take voice notes and photos?
   *
   * Asked once per connected session rather than assumed. The microphone and the
   * camera are hidden when the answer is no, because a control that sends a file the
   * shop cannot accept is worse than no control: the farmer talks for thirty seconds
   * and loses it. An older backend answers `PGRST202`, which reads as "not supported"
   * here and as an outage nowhere.
   */
  useEffect(() => {
    if (!configured || status !== 'ready' || !credential?.token) return;
    let cancelled = false;
    void mediaCapability(credential.token, serviceConfig.shopApi, activeShopId).then((supported) => {
      if (!cancelled) setMediaSupported(supported);
    });
    return () => {
      cancelled = true;
    };
  }, [activeShopId, configured, credential?.token, status]);

  /**
   * A reply arrives while the farmer is looking at the conversation — immediately.
   *
   * The shop writes the message, the credit decision or the visit move and broadcasts
   * it in the same transaction (the dealer app's `0339`), so the wait is a socket
   * frame rather than a poll interval. The subject is `realtime_topic`, which only
   * this credential is given: the app cannot derive it, and losing the credential
   * loses the channel.
   *
   * A `ready` event after the first join is a reconnection, and is treated as "read
   * again" — frames missed while offline are not replayed.
   */
  const realtimeTopic = me?.realtimeTopic ?? null;
  useEffect(() => {
    if (!configured || status !== 'ready' || !credential?.token || !realtimeTopic) return;
    const token = credential.token;
    let inFlight = false;

    const resync = async () => {
      if (inFlight) return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      inFlight = true;
      try {
        await load(token);
      } finally {
        inFlight = false;
      }
    };

    return subscribeShopTopic(serviceConfig.shopApi, realtimeTopic, () => void resync());
  }, [configured, credential?.token, load, realtimeTopic, status]);

  /**
   * The fallback: a shop backend with no channel, or a socket that will not open.
   *
   * It was the only mechanism before the shop broadcast existed, and it is kept
   * deliberately — a phone on a network that blocks WebSockets still converges, and
   * "slower" is a different failure from "never". It costs nothing in the
   * background: a hidden page does not tick.
   */
  useEffect(() => {
    if (!configured || status !== 'ready' || !credential?.token) return;
    const token = credential.token;
    let stopped = false;

    /* One read at a time: a slow reply must not stack a queue of them, each one
       overwriting the previous answer with an older one when it lands. */
    let inFlight = false;
    const tick = async () => {
      if (stopped || inFlight) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      inFlight = true;
      try {
        await load(token);
      } finally {
        inFlight = false;
      }
    };

    const timer = window.setInterval(() => void tick(), 5000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    /* Reconnecting is the one moment the screen is certainly stale. */
    const onOnline = () => void tick();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    window.addEventListener('online', onOnline);

    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, [configured, credential?.token, load, status]);

  const patchOutbox = useCallback((localId: string, patch: Partial<MediaOutboxItem>) => {
    setMediaOutbox((current) =>
      current.map((item) => (item.localId === localId ? { ...item, ...patch } : item)),
    );
  }, []);

  /**
   * Bytes → message row, for one recording or photo. Retry calls this again.
   *
   * The two steps are separate calls on the shop's side and they fail differently: a
   * failed upload leaves no message at all, while a failure at the second step leaves
   * an object nothing points at. Keeping the storage path in the outbox item is what
   * makes the second kind of retry cheap — the bytes are already stored.
   */
  const deliverMedia = useCallback(
    async (item: MediaOutboxItem): Promise<boolean> => {
      const token = current.current?.token;
      if (!token) return false;

      const sane = validateMedia(item.kind, item.blob, item.durationMs);
      if (!sane.ok) {
        patchOutbox(item.localId, { status: 'failed', error: sane.message });
        return false;
      }

      patchOutbox(item.localId, { status: 'sending', progress: 0, error: null });

      let stored = item.storagePath
        ? { storagePath: item.storagePath, mimeType: item.mimeType, sizeBytes: item.blob.size }
        : null;

      if (!stored) {
        const uploaded = await uploadMedia({
          token,
          kind: item.kind,
          blob: item.blob,
          mimeType: item.mimeType,
          /* The shop this file is for. Without it the shop has to guess which of
             the farmer's conversations the bytes belong to, and a farmer with two
             dealers is exactly the case it refuses. */
          shopId: item.shopId ?? activeShop.current,
          durationMs: item.durationMs,
          onProgress: (fraction) => patchOutbox(item.localId, { progress: fraction }),
        });

        if (!uploaded.ok) {
          /*
           * A refused upload does not end the conversation.
           *
           * Only the shop's own message contract can say the credential is gone.
           * The file endpoint is a separate function, and a 401 from it — a missing
           * secret, a gateway rule — used to clear a credential that still read and
           * sent text perfectly: the farmer lost every conversation because one
           * voice note would not upload. The failure stays on the file, with its
           * retry, and the thread stays.
           */
          patchOutbox(item.localId, { status: 'failed', error: uploaded.message });
          return false;
        }

        stored = uploaded.data;
        patchOutbox(item.localId, { storagePath: stored.storagePath, progress: 1 });
      }

      const sent = await sendAttachment({
        token,
        kind: item.kind,
        storagePath: stored.storagePath,
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
        durationMs: item.kind === 'voice' ? item.durationMs : undefined,
        /* The shop this file was recorded for, not whichever conversation is on
           screen when the upload finishes: a farmer who switches to another dealer
           mid-upload must not deliver a voice note to that dealer. */
        shopId: item.shopId ?? activeShop.current,
      });

      if (!sent.ok) {
        if (isTerminal(sent.error)) expire();
        patchOutbox(item.localId, { status: 'failed', error: sent.message });
        return false;
      }

      /* Gone from the outbox, and back from the thread: the bubble the farmer sees
         afterwards is the shop's row, not this phone's copy of it. */
      setMediaOutbox((current) => current.filter((entry) => entry.localId !== item.localId));
      await load(token);
      return true;
    },
    [expire, load, patchOutbox],
  );

  const sendMedia = useCallback(
    async (file: { kind: MediaKind; blob: Blob; mimeType: string; durationMs?: number }) => {
      const item: MediaOutboxItem = {
        localId: `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        shopId: activeShop.current,
        kind: file.kind,
        blob: file.blob,
        mimeType: file.mimeType,
        durationMs: file.durationMs ?? 0,
        storagePath: null,
        status: 'sending',
        progress: 0,
        error: null,
      };
      setMediaOutbox((current) => [...current, item]);
      return deliverMedia(item);
    },
    [deliverMedia],
  );

  const retryMedia = useCallback(
    async (localId: string) => {
      const item = mediaOutbox.find((entry) => entry.localId === localId);
      return item ? deliverMedia(item) : false;
    },
    [deliverMedia, mediaOutbox],
  );

  const discardMedia = useCallback((localId: string) => {
    setMediaOutbox((current) => current.filter((entry) => entry.localId !== localId));
  }, []);

  /**
   * A playable link, minted when it is needed.
   *
   * Sixty seconds is the whole life of the signature the shop mints, so nothing here
   * caches one: a cached URL is a message that plays today and is silent tomorrow,
   * with nothing on screen to explain why.
   */
  const resolveMediaUrl = useCallback(async (serverId: string | null | undefined) => {
    const token = current.current?.token;
    if (!token || !serverId) return null;
    const result = await mediaLink(token, serverId);
    return result.ok ? result.data.url : null;
  }, []);

  const joinWithLink = useCallback(
    async (link: string): Promise<boolean> => {
      const parsed = parseShopLink(link);
      if (!parsed) return false;
      return parsed.kind === 'join' ? joinWithCode(parsed.code) : adopt(parsed.token);
    },
    [adopt, joinWithCode],
  );

  /* A join link can arrive before the farmer has ever opened the app. */
  useEffect(() => {
    if (!configured) return;

    const fromUrl = (): string | null => {
      if (typeof window === 'undefined') return null;
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      const token = params.get('token');
      if (code) return `agrishop://join?code=${encodeURIComponent(code)}`;
      if (token) return `agrishop://farmer?token=${encodeURIComponent(token)}`;
      return null;
    };

    const link = fromUrl();
    if (link) {
      void joinWithLink(link);
      /* Read once: leaving it in the address bar would rejoin the shop on every
         reload, and on a shared phone the next farmer would inherit the scan. */
      const url = new URL(window.location.href);
      url.searchParams.delete('code');
      url.searchParams.delete('token');
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    }
  }, [configured, joinWithLink]);

  /* The custom scheme, which is how a sticker or an invitation reaches a phone
     that already has the app. */
  useEffect(() => {
    if (!configured || !Capacitor.isNativePlatform()) return;
    let remove: (() => void) | undefined;

    void (async () => {
      try {
        const { App } = await import('@capacitor/app');
        const launch = await App.getLaunchUrl();
        if (launch?.url) void joinWithLink(launch.url);

        const listener = await App.addListener('appUrlOpen', ({ url }) => {
          void joinWithLink(url);
        });
        remove = () => void listener.remove();
      } catch {
        // No App plugin: links open the browser instead, which is where the web
        // build picks the parameters up.
      }
    })();

    return () => remove?.();
  }, [configured, joinWithLink]);

  const run = useCallback(
    async (
      action: (token: string) => Promise<{ ok: true } | { ok: false; error: ShopApiFailure; message: string }>,
    ): Promise<boolean> => {
      const token = current.current?.token;
      if (!token) return false;
      setBusy(true);
      try {
        const result = await action(token);
        if (!result.ok) {
          if (isTerminal(result.error)) expire();
          else setFailure({ kind: result.error, message: result.message });
          return false;
        }
        setFailure(null);
        await load(token);
        return true;
      } finally {
        setBusy(false);
      }
    },
    [expire, load],
  );

  /**
   * Opens the conversation with one shop from the dealer's list.
   *
   * `farmer_api_contact_shop` is what creates the thread at the shop's side — the
   * farmer picking a shop that is already on the platform is the introduction, so
   * no code changes hands. The thread is then re-read for that shop, which is why
   * the screen afterwards shows the shop's own messages rather than this phone's.
   */
  const openShopConversation = useCallback(
    async (shopId: string): Promise<boolean> => {
      const token = current.current?.token;
      if (!token) return false;
      activeShop.current = shopId;
      setActiveShopId(shopId);
      setBusy(true);
      try {
        const opened = await farmerContactShop(token, shopId);
        if (!opened.ok) {
          if (isTerminal(opened.error)) {
            expire();
            return false;
          }
          setFailure({ kind: opened.error, message: opened.message });
        }
        return await load(token);
      } finally {
        setBusy(false);
      }
    },
    [expire, load],
  );

  /** The conversation the Chat screen has open. */
  const activeId = activeShopId ?? credential?.shopId ?? null;
  const thread = activeId ? (threads[activeId] ?? null) : null;

  /**
   * Unread messages, counted per conversation.
   *
   * The shop's notice names the message, not the shop, so each notice is credited
   * to the conversation whose thread holds that message. A notice whose message
   * this app has not read yet is not attributed to anybody: guessing a shop would
   * put a badge on the wrong conversation, which is worse than a missing badge.
   */
  const unreadByShop = useMemo(() => {
    const shopOfMessage = new Map<string, string>();
    for (const [shopId, entry] of Object.entries(threads)) {
      for (const message of entry.messages) {
        if (message.serverId) shopOfMessage.set(message.serverId, shopId);
      }
    }
    const counts = new Map<string, number>();
    for (const notice of notifications) {
      if (notice.kind !== 'message' || seen.includes(notice.id) || !notice.messageId) continue;
      const shopId = shopOfMessage.get(notice.messageId);
      if (!shopId) continue;
      counts.set(shopId, (counts.get(shopId) ?? 0) + 1);
    }
    return counts;
  }, [notifications, seen, threads]);

  /**
   * Every dealer conversation, newest first.
   *
   * Built from the threads read above, so a conversation exists in the list only
   * when the shop network answered for it — the account's conversations, not the
   * nearby shops and not the shop last opened.
   */
  const conversations = useMemo<ShopConversation[]>(() => {
    const rows = Object.keys(threads).map((shopId) => {
      const entry = threads[shopId];
      const summary = shops.find((shop) => shop.shopId === shopId);
      const messages = entry?.messages ?? [];
      const lastMessage = messages[messages.length - 1] ?? null;
      const name =
        entry?.shopName ||
        summary?.name ||
        (shopId === credential?.shopId ? credential.shopName : '') ||
        '';

      return {
        shopId,
        name,
        phone: entry?.shopPhone ?? summary?.phone ?? null,
        messages,
        lastMessage,
        lastAt: lastMessage?.sentAt ?? null,
        unread: unreadByShop.get(shopId) ?? 0,
      } satisfies ShopConversation;
    });

    /* Newest conversation first, as a message list should be; a conversation that
       has not been written to yet follows those, under its own name. */
    return rows
      .filter((row) => row.name.length > 0)
      .sort((a, b) => {
        if (a.lastAt && b.lastAt) return b.lastAt.localeCompare(a.lastAt);
        if (a.lastAt) return -1;
        if (b.lastAt) return 1;
        return a.name.localeCompare(b.name);
      });
  }, [credential?.shopId, credential?.shopName, shops, threads, unreadByShop]);

  /**
   * Marks one conversation's notices read, or all of them when no shop is named.
   *
   * Reading a conversation is what clears its badge, and clearing one must not
   * clear the others: a farmer who answers Auto Shop has not read Dealer B's
   * message.
   */
  const markNotificationsRead = useCallback(
    (shopId?: string) => {
      const ids = !shopId
        ? notifications.map((notice) => notice.id)
        : (() => {
            const shopOfMessage = new Map<string, string>();
            for (const [id, entry] of Object.entries(threads)) {
              for (const message of entry.messages) {
                if (message.serverId) shopOfMessage.set(message.serverId, id);
              }
            }
            return notifications
              .filter(
                (notice) =>
                  notice.kind === 'message' &&
                  notice.messageId &&
                  shopOfMessage.get(notice.messageId) === shopId,
              )
              .map((notice) => notice.id);
          })();

      if (ids.length === 0) return;
      const next = [...new Set([...seen, ...ids])];
      saveSeen(next);
      setSeen(next);
    },
    [notifications, seen, threads],
  );

  const value = useMemo<ShopApiValue>(() => {
    const unread = conversations.reduce((total, conversation) => total + conversation.unread, 0);

    return {
      status,
      configured,
      credential,
      me,
      thread,
      threads,
      conversations,
      shops,
      notifications,
      unread,
      busy,
      failure,
      joinWithCode,
      joinWithLink,
      forget: () => {
        clearShopCredential();
        void clearAccountCredential(accountId.current);
        expire();
      },
      activeShopId,
      openShopConversation,
      send: (text, shopId = null) =>
        run((token) => farmerSendMessage(token, text, shopId ?? activeShop.current)),
      mediaSupported,
      mediaOutbox,
      sendMedia,
      retryMedia,
      discardMedia,
      resolveMediaUrl,
      askCredit: (amount, note) =>
        run((token) => farmerCreateCreditRequest(token, amount, note, activeShop.current)),
      askVisit: (purpose, window) =>
        run((token) => farmerRequestVisit(token, purpose, window, activeShop.current)),
      answerOffer: (requestId, accept, note) =>
        run((token) => farmerAnswerOffer(token, requestId, accept, note)),
      refresh,
      markNotificationsRead,
      seenNotificationIds: seen,
    };
  }, [
    activeShopId,
    conversations,
    markNotificationsRead,
    openShopConversation,
    credential,
    configured,
    failure,
    discardMedia,
    retryMedia,
    sendMedia,
    mediaOutbox,
    mediaSupported,
    resolveMediaUrl,
    joinWithCode,
    joinWithLink,
    me,
    notifications,
    refresh,
    run,
    seen,
    status,
    shops,
    thread,
    threads,
    busy,
  ]);

  return <ShopApiContext.Provider value={value}>{children}</ShopApiContext.Provider>;
}

export function useShopApi(): ShopApiValue {
  const context = useContext(ShopApiContext);
  if (!context) throw new Error('useShopApi must be used inside a ShopApiProvider');
  return context;
}
