/**
 * Durable storage: one document per collection, per farmer.
 *
 * This is the layer the brief demanded instead of "screen → localStorage random
 * object". Every store in the app holds its data through `usePersistentDocument`,
 * which does four things that used to be copied into each provider — and copied
 * slightly differently each time:
 *
 *   1. Reads the phone's copy synchronously, so the first paint is correct and a
 *      farmer never sees an empty screen flash before their own data appears.
 *   2. Reconciles with the repository, which is where the backend lives when one
 *      is configured. The backend wins when it has something; when it has
 *      nothing, the device's document is *pushed up* — which is exactly the
 *      "migrate the guest's farming context when they make an account" rule, done
 *      once for every collection instead of once per feature.
 *   3. Writes to the phone immediately and to the repository through a coalescing
 *      queue, so a burst of taps is one request and a write that fails is retried
 *      rather than lost.
 *   4. Reports whether the document is saved, still waiting, or failed — the
 *      states the UI is required to be honest about.
 *
 * Two decisions worth stating, because they are the kind of thing that is obvious
 * only after it has gone wrong:
 *
 * · The phone's mirror is keyed by collection, not by account. A farm phone
 *   belongs to one farmer, and a document that changed its key at sign-in would
 *   mean a farmer losing their crops by signing in. The account identity is used
 *   for the *backend* document, so a farmer who signs in on a second phone gets
 *   their data — and the device copy stays the thing that works with no network.
 *
 * · Read is async and write is not awaited by callers. A store that had to await
 *   a network write before showing a farmer their own post would be a store that
 *   is broken in a village with two bars of signal.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { useServicesOrDefault } from './registry';
import type { Collection, Repository } from './types';

/* -------------------------------------------------------------------------- */
/* The phone's copy                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Where a farmer's data lives on the device.
 *
 * Scoped by owner, because the owner is what makes the copy *this farmer's*. An
 * unscoped key was a real defect, not a shortcut: after signing out, the next
 * person holding the phone opened the app and was shown the previous account's
 * posts, credit requests and conversations until the backend answered — on a
 * shared phone, which is the ordinary case for this product.
 *
 * The device owner keeps the plain name the stores used before this layer
 * existed, so an installed app still finds its own data after an update rather
 * than appearing to have been wiped. An account's copy lives beside it.
 */
export function mirrorKey(collection: Collection, ownerId: string): string {
  return ownerId === deviceOwnerId()
    ? `agri-shop.${collection}`
    : `agri-shop.${collection}.${ownerId}`;
}

/** The device's farmer id: created on first launch, never rotated. */
export const DEVICE_OWNER_KEY = 'agri-shop.device-id';

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  }
  return Math.random().toString(36).slice(2, 14);
}

export function deviceOwnerId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_OWNER_KEY);
    if (existing) return existing;
    const created = `device-${randomId()}`;
    localStorage.setItem(DEVICE_OWNER_KEY, created);
    return created;
  } catch {
    /* Storage blocked. Reads still work this session; nothing can be persisted,
       and every screen that says "saved on this phone" says so from status. */
    return 'device-ephemeral';
  }
}

/**
 * Which document this device is working on: the account's when signed in, the
 * device's own otherwise.
 *
 * The account id is only used to talk to the backend. Signing in therefore has no
 * effect on what is already on the phone — it adds a second, more portable place
 * for the same document to live.
 */
export function ownerFor(accountId: string | null): string {
  return accountId && accountId.length > 0 ? accountId : deviceOwnerId();
}

export function readMirror(collection: Collection, ownerId: string): string | null {
  try {
    return localStorage.getItem(mirrorKey(collection, ownerId));
  } catch {
    return null;
  }
}

/**
 * The same read, with the failure left in place.
 *
 * `readMirror` folds "nothing stored" and "storage refused" into one null, which
 * is right for a caller that only wants a value and wrong for the document layer:
 * those two are different situations, and only one of them is an error a farmer
 * can be told about and can retry. Private browsing, a sandboxed frame and a full
 * quota all land here.
 */
function readMirrorStrict(collection: Collection, ownerId: string): string | null {
  return localStorage.getItem(mirrorKey(collection, ownerId));
}

export function writeMirror(collection: Collection, ownerId: string, raw: string): boolean {
  try {
    localStorage.setItem(mirrorKey(collection, ownerId), raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep a copy of a document that is about to be replaced by a different one.
 *
 * This fires in exactly one situation: a guest with data on this phone signs in
 * as an account that already has a document on the backend — a farmer who has
 * used the app on another phone. The account's document wins, because it is the
 * farmer's real record and the guest document is whatever was typed on this one;
 * but "wins" must not mean "deleted", so the replaced copy is parked where a
 * developer can recover it. One archived copy per collection, not a pile: this is
 * a safety net, not a version history.
 */
export function archiveMirror(collection: Collection, ownerId: string, raw: string): void {
  try {
    localStorage.setItem(`${mirrorKey(collection, ownerId)}.replaced`, raw);
  } catch {
    /* Nothing to do: the archive is best-effort by definition. */
  }
}

export function readArchivedMirror(collection: Collection, ownerId: string): string | null {
  try {
    return localStorage.getItem(`${mirrorKey(collection, ownerId)}.replaced`);
  } catch {
    return null;
  }
}

/**
 * Whether the mirror can be written at all.
 *
 * Checked once, at load, because "storage is full" is the failure that otherwise
 * surfaces as data quietly disappearing between launches.
 */
export function mirrorWritable(): boolean {
  try {
    const probe = 'agri-shop.probe';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Connectivity                                                                */
/* -------------------------------------------------------------------------- */

function subscribeOnline(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

function onlineSnapshot(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine !== false;
}

/** Being offline is a state, not an error — the UI is required to distinguish them. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, onlineSnapshot, () => true);
}

/* -------------------------------------------------------------------------- */
/* The write queue                                                             */
/* -------------------------------------------------------------------------- */

export type QueueSnapshot = {
  /** Documents written on the phone but not yet accepted by the repository. */
  pending: number;
  /** Why the last attempt failed, when it did. Cleared on success. */
  error: string | null;
};

type QueuedWrite = {
  collection: Collection;
  ownerId: string;
  value: unknown;
  attempts: number;
};

/**
 * Backoff for a write that failed. Short first, capped, and never fatal: the
 * document is already safe on the phone, so a retry is about reaching the
 * backend, not about rescuing the farmer's data.
 */
const RETRY_DELAYS_MS = [1_000, 3_000, 8_000, 20_000, 30_000] as const;

/**
 * One queue for the whole app, not one per store.
 *
 * A shared queue means a single retry timer and a single "3 changes waiting"
 * count, which is what a status line needs to say something true. Coalescing is
 * per (collection, owner) key: if a farmer taps five times, the backend receives
 * the fifth state, not five states.
 */
class WriteQueue {
  private entries = new Map<string, QueuedWrite>();
  private listeners = new Set<() => void>();
  private snapshot: QueueSnapshot = { pending: 0, error: null };
  private repository: Repository | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;

  attach(repository: Repository): void {
    this.repository = repository;
    /* A repository change (local → real backend) means anything waiting should be
       retried immediately rather than after the backoff the old one earned. */
    if (this.entries.size > 0) void this.flush();
  }

  private publish(): void {
    const next: QueueSnapshot = {
      pending: this.entries.size,
      error: [...this.entries.values()].some((entry) => entry.attempts > 0)
        ? this.snapshot.error
        : null,
    };
    if (next.pending === this.snapshot.pending && next.error === this.snapshot.error) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  private key(collection: Collection, ownerId: string): string {
    return `${collection}:${ownerId}`;
  }

  enqueue(collection: Collection, ownerId: string, value: unknown): void {
    this.entries.set(this.key(collection, ownerId), {
      collection,
      ownerId,
      value,
      attempts: 0,
    });
    this.publish();
    void this.flush();
  }

  async flush(): Promise<void> {
    if (this.inFlight) {
      await this.inFlight;
      return;
    }
    if (!this.repository || this.entries.size === 0) return;

    this.inFlight = this.drain();
    await this.inFlight;
    this.inFlight = null;
  }

  private async drain(): Promise<void> {
    const repository = this.repository;
    if (!repository) return;

    for (const [key, entry] of [...this.entries]) {
      try {
        await repository.write(entry.collection, entry.ownerId, entry.value);
        // Removed only if it was not replaced while the write was in flight.
        if (this.entries.get(key) === entry) this.entries.delete(key);
        this.snapshot = { ...this.snapshot, error: null, pending: this.entries.size };
        this.publish();
      } catch (error) {
        entry.attempts += 1;
        this.snapshot = {
          pending: this.entries.size,
          error: error instanceof Error ? error.message : 'Write failed.',
        };
        this.publish();
        this.scheduleRetry(entry.attempts);
        /* Leave the rest queued: a backend that refused one write is likely to
           refuse the next, and hammering it is not a fix. */
        return;
      }
    }
  }

  private scheduleRetry(attempt: number): void {
    if (this.timer !== null) return;
    const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)] as number;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  getSnapshot(): QueueSnapshot {
    return this.snapshot;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** For tests and for sign-out: drop what is queued instead of retrying it. */
  clear(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.entries.clear();
    this.snapshot = { pending: 0, error: null };
    this.publish();
  }
}

const writeQueue = new WriteQueue();

/** Attach the live repository. Called once by the services provider. */
export function attachRepository(repository: Repository): void {
  writeQueue.attach(repository);
}

/** Wait for everything queued to be written. Used by tests and by sign-out. */
export function flushWrites(): Promise<void> {
  return writeQueue.flush();
}

export function pendingWrites(): number {
  return writeQueue.getSnapshot().pending;
}

export function useWriteQueue(): QueueSnapshot & { flush: () => void } {
  const snapshot = useSyncExternalStore(writeQueue.subscribe, () => writeQueue.getSnapshot());
  return useMemo(
    () => ({ ...snapshot, flush: () => void writeQueue.flush() }),
    [snapshot],
  );
}

/* -------------------------------------------------------------------------- */
/* Backend health, for the farmer to see                                       */
/* -------------------------------------------------------------------------- */

/**
 * The last time the repository could not be reached, for *any* document.
 *
 * Kept outside React, like the queue, because it is a fact about the connection
 * rather than about one store — and because the screen that reports it must be
 * able to do so without every store having to pass its own failure upwards.
 *
 * The point of surfacing it at all is that the app must never look like it saved
 * something it did not. A farmer on two bars of signal can see that their posts
 * are on the phone and not yet shared, which is the difference between an app that
 * is working and an app that is lying.
 */
let syncFailure: string | null = null;
const syncFailureListeners = new Set<() => void>();

function subscribeSyncFailure(listener: () => void): () => void {
  syncFailureListeners.add(listener);
  return () => {
    syncFailureListeners.delete(listener);
  };
}

/** Called by the document layer: null when a read succeeds, a message when it did not. */
export function reportSyncFailure(message: string | null): void {
  if (syncFailure === message) return;
  syncFailure = message;
  for (const listener of syncFailureListeners) listener();
}

export type SyncHealth = {
  /** True while the backend is unreachable or refusing writes. */
  failing: boolean;
  /** What went wrong, as the backend said it. Null when nothing has. */
  message: string | null;
  /** Documents written here and not yet accepted by the backend. */
  pending: number;
  /** Try now, rather than waiting for the backoff. */
  flush: () => void;
};

export function useSyncHealth(): SyncHealth {
  const queue = useWriteQueue();
  const failure = useSyncExternalStore(subscribeSyncFailure, () => syncFailure);
  const message = queue.error ?? failure;
  return useMemo(
    () => ({
      failing: message !== null,
      message,
      pending: queue.pending,
      flush: queue.flush,
    }),
    [message, queue.pending, queue.flush],
  );
}

/* -------------------------------------------------------------------------- */
/* The document hook                                                           */
/* -------------------------------------------------------------------------- */

export type SyncStatus =
  /** Reading the repository. The phone's copy, if any, is already on screen. */
  | 'loading'
  /** Saved, and the repository agrees. */
  | 'ready'
  /**
   * The phone has the document and the backend does not agree — either because a
   * write has not been accepted yet, or because the backend could not be reached.
   * The screen shows what it has and says it is not syncing.
   */
  | 'offline'
  /**
   * Nothing could produce the document: the backend refused *and* the phone's own
   * storage did not have it. This is the one failure that has to be reported,
   * because the content behind it is not the farmer's.
   */
  | 'error';

export type PersistentDocument<T> = {
  data: T;
  setData: Dispatch<SetStateAction<T>>;
  status: SyncStatus;
  /** How many changes are waiting for the backend. Zero in a healthy app. */
  pending: number;
  /** What the backend said, when it said no. Surfaced rather than swallowed. */
  syncError: string | null;
  /** Whether the phone can persist at all. False means this session only. */
  durable: boolean;
  /** Re-read the repository. The retry control behind every error state. */
  reload: () => void;
};

export type DocumentSpec<T> = {
  collection: Collection;
  ownerId: string;
  /** First-run content when there is nothing stored and nothing on the backend. */
  seed: () => T;
  /**
   * The store's own validator, applied to *both* sources. Remote data is run
   * through it too, so a half-written document from a newer app version is
   * refused in the same place a corrupt one on the phone is.
   */
  hydrate: (raw: string | null, now: number) => T | null;
  serialise: (value: T) => string;
  /** Injectable clock, so tests can drive expiry without waiting. */
  now?: () => number;
};

export function usePersistentDocument<T>(spec: DocumentSpec<T>): PersistentDocument<T> {
  const { collection, ownerId, seed, hydrate, serialise } = spec;
  const now = spec.now ?? Date.now;
  const { repository } = useServicesOrDefault();
  const online = useOnline();
  const queue = useWriteQueue();

  /* Named `specRef` rather than destructured into effects: the spec's functions
     are recreated on every render by most callers, and an effect that depended on
     them would reload the document on every keystroke. */
  const specRef = useRef(spec);
  specRef.current = spec;

  const [durable, setDurable] = useState(mirrorWritable);
  const [loadFailed, setLoadFailed] = useState(false);
  /** What the backend said when it could not be read. Null while it is working. */
  const [readError, setReadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  const initial = useMemo(() => {
    try {
      const stored = hydrate(readMirrorStrict(collection, ownerId), now());
      return stored ?? seed();
    } catch {
      /* The phone will not open its storage. Start from the seed and let the
         load decide whether that is reportable — it is not, if the backend has
         the real document. */
      return seed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collection, ownerId]);

  const [data, setData] = useState<T>(initial);

  /**
   * The exact bytes last agreed with the repository.
   *
   * The write effect compares against it so that adopting remote data does not
   * immediately look like a local change and echo back as a write. Without this
   * the app would send a document to the backend every time it *received* one.
   */
  const syncedRaw = useRef<string | null>(null);
  const ownerRef = useRef(ownerId);


  useEffect(() => {
    let cancelled = false;
    const current = specRef.current;
    const isOwnerChange = ownerRef.current !== ownerId;
    ownerRef.current = ownerId;

    /*
     * Signing *out*: the account's document is not this guest's to look at, so it
     * is replaced now — from this device's own copy, or from the seed — rather
     * than left on the screen until the backend answers. Signing *in* is the other
     * direction and is deliberately not treated this way: what is on screen there
     * is the guest's own work, and it is about to become the account's.
     */
    if (isOwnerChange && ownerId === deviceOwnerId()) {
      let own: T | null = null;
      try {
        own = current.hydrate(readMirrorStrict(collection, ownerId), current.now?.() ?? Date.now());
      } catch {
        own = null;
      }
      setData(own ?? current.seed());
      syncedRaw.current = null;
    }

    const load = async () => {
      setLoading(true);

      /* Whether this phone can open its own storage, checked on every attempt so
         that a retry after the farmer frees up space actually recovers. */
      let readable = true;
      try {
        readMirrorStrict(collection, ownerId);
      } catch {
        readable = false;
      }
      setDurable(mirrorWritable());

      try {
        const remote = await repository.read<unknown>(collection, ownerId);
        if (cancelled) return;
        setReadError(null);

        if (remote !== null) {
          reportSyncFailure(null);
          /*
           * What the backend holds is the document's own bytes — the string the
           * store's `serialise` produced. The object case is tolerated because a
           * row written by an older build, or by an API client, may hold the
           * parsed object instead; the store's validator is the judge either way.
           */
          const raw = typeof remote === 'string' ? remote : JSON.stringify(remote);
          const revived = current.hydrate(raw, current.now?.() ?? Date.now());

          if (revived !== null) {
            const bytes = current.serialise(revived);
            /*
             * Signing in as an account that already has a document elsewhere:
             * the account's record wins, and the device's copy is parked rather
             * than dropped. Only on an owner change — a plain restart finding a
             * newer backend copy is ordinary sync, not a replacement.
             */
            const existing = readMirror(collection, ownerId);
            if (isOwnerChange && existing !== null && existing !== bytes) {
              archiveMirror(collection, ownerId, existing);
            }
            syncedRaw.current = bytes;
            setData(revived);
            writeMirror(collection, ownerId, bytes);
            setLoadFailed(false);
            setLoading(false);
            return;
          }

          /*
           * The backend has a document, and this build cannot read it.
           *
           * It is left exactly as it is. Overwriting a document that could not be
           * parsed with whatever happens to be on this phone is how a version skew
           * turns into data loss — the farmer's real record is the one on the
           * backend, and the honest response is to say the two are not in step.
           */
          writeMirror(collection, ownerId, current.serialise(data));
          setReadError('The stored document was not readable by this version.');
          reportSyncFailure('The stored document was not readable by this version.');
          setLoadFailed(false);
          setLoading(false);
          return;
        }

        /*
         * The backend has nothing for this owner. Two cases, one behaviour:
         *
         *   · first run — the seed becomes the backend's starting document
         *   · a guest signing in — the device's document is migrated to the
         *     account, which is the "carry the farming context into the account"
         *     rule, enforced for every collection at once
         *
         * In both cases the bytes sent are the ones the farmer is looking at —
         * read from *this owner's* copy on the phone rather than closed over,
         * because on an owner change the render's `data` still belongs to the
         * previous owner. And what is sent is the document's own bytes, not the
         * in-memory state: the store's `hydrate` is the reader on the way back, so
         * a write that skipped it could never be read at all.
         */
        let deviceCopy: T | null = null;
        try {
          deviceCopy = current.hydrate(
            readMirrorStrict(collection, ownerId),
            current.now?.() ?? Date.now(),
          );
        } catch {
          deviceCopy = null;
        }

        const bytes = current.serialise(deviceCopy ?? data);
        syncedRaw.current = bytes;
        writeMirror(collection, ownerId, bytes);
        writeQueue.enqueue(collection, ownerId, bytes);
        /*
         * Neither source could produce the farmer's document: the phone refused
         * and the backend has nothing for this owner. That is the one failure the
         * layer must report rather than paper over with a seed presented as the
         * farmer's own data.
         */
        setLoadFailed(!readable);
        setLoading(false);
      } catch (error) {
        if (cancelled) return;
        /*
         * The backend could not be reached. That is not the same as having no
         * document: if the phone could open its own copy, the farmer's data is on
         * screen and this is a sync failure — a village phone with no signal must
         * still show the posts, the credit requests and the conversations that are
         * already on it. Only when *neither* source could produce a document does
         * the screen report an error, because only then is the content not the
         * farmer's.
         */
        const message =
          error instanceof Error ? error.message : 'The backend could not be reached.';
        setReadError(message);
        reportSyncFailure(message);
        setLoadFailed(!readable);
        setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
    // `data` is read at the moment of the load on purpose — reading the *current*
    // document is what makes the migration send what the farmer is looking at.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collection, ownerId, repository, attempt]);

  /* Push the document up whenever it changes, and record it on the phone first. */
  const first = useRef(true);
  useEffect(() => {
    /*
     * Nothing is pushed up while the load for this owner is still running.
     *
     * Deferred, not dropped, and that distinction is the whole reason `loading` is
     * a dependency: on signing in, this effect used to fire on the first render of
     * the new owner with the *guest's* document still in `data`, and push it up —
     * overwriting the account's real document with the guest's copy before the load
     * had read it. Now the change is kept, and lands once the document's owner is
     * known. That is also what makes a request made *during* the sign-in round trip
     * durable rather than lost.
     */
    if (loading) return;

    const raw = serialise(data);
    if (first.current) {
      first.current = false;
      if (syncedRaw.current === null) writeMirror(collection, ownerId, raw);
      return;
    }
    if (raw === syncedRaw.current) return;
    syncedRaw.current = raw;
    writeMirror(collection, ownerId, raw);
    /* The document's own bytes, not the state object: `hydrate` is what reads it
       back, and it cannot read a shape it did not write. */
    writeQueue.enqueue(collection, ownerId, raw);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, collection, ownerId, loading]);

  /* Coming back online drains everything that was written while there was no
     network. This is the "recovery" half of the offline requirement. */
  useEffect(() => {
    if (online && queue.pending > 0) void writeQueue.flush();
  }, [online, queue.pending]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  /*
   * A failing *write* never takes the screen down: the document is on the phone,
   * the farmer keeps working, and the queue says so through `pending`/`syncError`.
   * A failing read is reported the same way when the phone's copy was usable.
   */
  const status: SyncStatus = loadFailed
    ? 'error'
    : loading
      ? 'loading'
      : queue.pending > 0 || readError !== null || !online
        ? 'offline'
        : 'ready';

  return {
    data,
    setData,
    status,
    pending: queue.pending,
    syncError: queue.error ?? readError,
    durable,
    reload,
  };
}

/**
 * Attach the live repository to the shared queue.
 *
 * The hook reads its repository straight from the services context, so this call
 * exists for the parts of the queue that run outside React: the retry timer, the
 * reconnect flush, and the test helper that waits for the queue to drain.
 */
export function publishRepository(repository: Repository): void {
  attachRepository(repository);
}

/** Test seam: empty the queue instead of letting a previous test's retry fire. */
export function resetPersistence(): void {
  writeQueue.clear();
  reportSyncFailure(null);
}
