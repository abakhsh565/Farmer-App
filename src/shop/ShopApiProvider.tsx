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
import { sendVoiceNote, voiceCapability } from './api/voice';
import { toE164 } from '@/services/supabaseClient';
import { useSession } from '@/session/SessionProvider';
import {
  farmerAnswerOffer,
  farmerCreateCreditRequest,
  farmerJoinShop,
  farmerMe,
  farmerNotifications,
  farmerRequestVisit,
  farmerSendMessage,
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
import { parseShopLink } from './api/deepLink';
import {
  firstRow,
  normaliseMe,
  normaliseNotifications,
  normaliseThread,
  type ShopMe,
  type ShopNotification,
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
 * A recording this phone is still delivering.
 *
 * The blob lives here, not in the thread, because the thread is the shop's record
 * of what was said and a note that has not arrived is not part of it yet. Keeping it
 * out of `thread` is also what makes retry honest: the bubble shows the recording
 * it will actually re-send, with progress and a failure it can recover from.
 */
export type VoiceOutboxItem = {
  localId: string;
  blob: Blob;
  mimeType: string;
  durationMs: number;
  status: 'sending' | 'failed';
  /** 0…1 while uploading. */
  progress: number;
  error: string | null;
};

type ShopApiValue = {
  status: ShopApiStatus;
  configured: boolean;
  credential: ShopCredential | null;
  me: ShopMe | null;
  thread: ShopThread | null;
  notifications: ShopNotification[];
  unread: number;
  busy: boolean;
  failure: ShopFailure;
  joinWithCode: (code: string) => Promise<boolean>;
  joinWithLink: (link: string) => Promise<boolean>;
  forget: () => void;
  send: (text: string) => Promise<boolean>;
  /** True once the shop backend has answered the voice contract. */
  voiceSupported: boolean;
  /** Recordings on their way to the shop, newest last. */
  voiceOutbox: VoiceOutboxItem[];
  sendVoice: (recording: { blob: Blob; mimeType: string; durationMs: number }) => Promise<boolean>;
  retryVoice: (localId: string) => Promise<boolean>;
  discardVoice: (localId: string) => void;
  askCredit: (amount: number, note: string | null) => Promise<boolean>;
  askVisit: (purpose: string | null, window: string | null) => Promise<boolean>;
  answerOffer: (requestId: string, accept: boolean, note: string | null) => Promise<boolean>;
  refresh: () => Promise<void>;
  markNotificationsRead: () => void;
  /** The notices the farmer has already seen, so the badge counts something real. */
  seenNotificationIds: string[];
};

const ShopApiContext = createContext<ShopApiValue | null>(null);

const SEEN_KEY = 'farmer.shop.notifications.seen';

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
  const [thread, setThread] = useState<ShopThread | null>(null);
  const [notifications, setNotifications] = useState<ShopNotification[]>([]);
  const [failure, setFailure] = useState<ShopFailure>(null);
  const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState<string[]>(loadSeen);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [voiceOutbox, setVoiceOutbox] = useState<VoiceOutboxItem[]>([]);

  /** The credential as it is *now*, for callbacks that outlive a render. */
  const current = useRef<ShopCredential | null>(credential);
  current.current = credential;

  const expire = useCallback(() => {
    clearShopCredential();
    setCredential(null);
    setMe(null);
    setThread(null);
    setNotifications([]);
    setStatus('expired');
  }, []);

  /** Reads the thread and the outbox for a credential that is already trusted. */
  const load = useCallback(
    async (token: string): Promise<boolean> => {
      const [meResult, threadResult, notificationsResult] = await Promise.all([
        farmerMe(token),
        farmerThread(token),
        farmerNotifications(token),
      ]);

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
      /* A thread that failed on its own is not a reason to blank the screen the
         farmer just opened: an empty conversation with the shop named above it is
         the honest rendering, and the next refresh fills it. */
      setThread(threadResult.ok ? normaliseThread(threadResult.data) : null);
      setNotifications(notificationsResult.ok ? normaliseNotifications(notificationsResult.data) : []);

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
    const token = loadShopCredential()?.token;
    if (!token) {
      setStatus('no-credential');
      return;
    }
    void load(token);
  }, [configured, load]);

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
   * Does this shop take voice notes?
   *
   * Asked once per connected session rather than assumed. The mic is hidden when the
   * answer is no, because a control that records a message the shop cannot accept is
   * worse than no control: the farmer talks for thirty seconds and loses it. An old
   * backend answers `PGRST202`, which reads as "not supported" here and as an
   * outage nowhere.
   */
  useEffect(() => {
    if (!configured || status !== 'ready' || !credential?.token) return;
    let cancelled = false;
    void voiceCapability(credential.token).then((supported) => {
      if (!cancelled) setVoiceSupported(supported);
    });
    return () => {
      cancelled = true;
    };
  }, [configured, credential?.token, status]);

  const patchOutbox = useCallback((localId: string, patch: Partial<VoiceOutboxItem>) => {
    setVoiceOutbox((current) =>
      current.map((item) => (item.localId === localId ? { ...item, ...patch } : item)),
    );
  }, []);

  /** Ticket → bytes → message, for one recording. Retry calls this again. */
  const deliverVoice = useCallback(
    async (item: VoiceOutboxItem): Promise<boolean> => {
      const token = current.current?.token;
      if (!token) return false;

      patchOutbox(item.localId, { status: 'sending', progress: 0, error: null });

      const result = await sendVoiceNote({
        token,
        blob: item.blob,
        durationMs: item.durationMs,
        mimeType: item.mimeType,
        onProgress: (fraction) => patchOutbox(item.localId, { progress: fraction }),
      });

      if (!result.ok) {
        if (isTerminal(result.error)) expire();
        patchOutbox(item.localId, { status: 'failed', error: result.message });
        return false;
      }

      /* Gone from the outbox, and back from the thread: the bubble the farmer sees
         afterwards is the shop's row, not this phone's copy of it. */
      setVoiceOutbox((current) => current.filter((entry) => entry.localId !== item.localId));
      await load(token);
      return true;
    },
    [expire, load, patchOutbox],
  );

  const sendVoice = useCallback(
    async (recording: { blob: Blob; mimeType: string; durationMs: number }) => {
      const item: VoiceOutboxItem = {
        localId: `v-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ...recording,
        status: 'sending',
        progress: 0,
        error: null,
      };
      setVoiceOutbox((current) => [...current, item]);
      return deliverVoice(item);
    },
    [deliverVoice],
  );

  const retryVoice = useCallback(
    async (localId: string) => {
      const item = voiceOutbox.find((entry) => entry.localId === localId);
      return item ? deliverVoice(item) : false;
    },
    [deliverVoice, voiceOutbox],
  );

  const discardVoice = useCallback((localId: string) => {
    setVoiceOutbox((current) => current.filter((entry) => entry.localId !== localId));
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

  const value = useMemo<ShopApiValue>(() => {
    const unread = notifications.filter(
      (entry) => entry.kind === 'message' && !seen.includes(entry.id),
    ).length;

    return {
      status,
      configured,
      credential,
      me,
      thread,
      notifications,
      unread,
      busy,
      failure,
      joinWithCode,
      joinWithLink,
      forget: () => {
        clearShopCredential();
        expire();
      },
      send: (text) => run((token) => farmerSendMessage(token, text)),
      voiceSupported,
      voiceOutbox,
      sendVoice,
      retryVoice,
      discardVoice,
      askCredit: (amount, note) => run((token) => farmerCreateCreditRequest(token, amount, note)),
      askVisit: (purpose, window) => run((token) => farmerRequestVisit(token, purpose, window)),
      answerOffer: (requestId, accept, note) =>
        run((token) => farmerAnswerOffer(token, requestId, accept, note)),
      refresh,
      markNotificationsRead: () => {
        const next = [...new Set([...seen, ...notifications.map((entry) => entry.id)])];
        saveSeen(next);
        setSeen(next);
      },
      seenNotificationIds: seen,
    };
  }, [
    credential,
    configured,
    failure,
    discardVoice,
    retryVoice,
    sendVoice,
    voiceOutbox,
    voiceSupported,
    joinWithCode,
    joinWithLink,
    me,
    notifications,
    refresh,
    run,
    seen,
    status,
    thread,
    busy,
  ]);

  return <ShopApiContext.Provider value={value}>{children}</ShopApiContext.Provider>;
}

export function useShopApi(): ShopApiValue {
  const context = useContext(ShopApiContext);
  if (!context) throw new Error('useShopApi must be used inside a ShopApiProvider');
  return context;
}
