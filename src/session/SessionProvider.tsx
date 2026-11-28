import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { useLocale } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/catalog';
import { deviceOwnerId, usePersistentDocument, type SyncStatus } from '@/services/persistence';
import { CredentialSheet } from './CredentialSheet';
import {
  adoptAccount,
  cancelRequest,
  createState,
  hydrate,
  markContextMigrated,
  requestAccount,
  serialise,
  setPartyId,
  signIn as signInWith,
  signOut as signOutOf,
  type Account,
  type Result,
  type SessionState,
} from './store';
import { reconcileSession } from './reconcile';

/**
 * The identity gate every accountable action goes through.
 *
 * `requestIdentity(action, reason)` is the whole API: if there is an account the
 * action runs immediately and the caller carries on; if not, the sheet opens with
 * the reason, and the *same action* runs the moment sign-in succeeds. Call sites
 * never branch on `isGuest`, which is what keeps the gate honest — there is no
 * second code path where a gated action could slip through because someone forgot
 * to check.
 *
 * The caller's action is kept in a ref, not in state: it closes over a draft that
 * must survive the round trip, and serialising a function to storage would both
 * break that and persist an action across launches, which is not what a farmer
 * agreed to by signing in.
 *
 * The sheet itself is one component for every entry point — a gated post, a
 * dealer message, or the Login button on Profile — so there is one flow to get
 * right rather than one per button.
 */

export type SessionValue = {
  account: Account | null;
  isGuest: boolean;
  /** Runs now and returns true; opens the sheet and returns false otherwise. */
  requestIdentity: (action: () => void, reason: MessageKey) => boolean;
  signIn: (input: {
    method: 'phone' | 'email';
    contact: string;
    name?: string;
    partyId?: string | null;
  }) => Result;
  signOut: () => void;
  /** Opens the sheet with no action behind it — the Profile entry point. */
  prompt: (reason: MessageKey) => void;
  /** The reason on the open sheet, if it is open. */
  pendingReason: MessageKey | null;
  dismiss: () => void;
  /** How the identity document is doing against the backend, for the Profile row. */
  sync: SyncStatus;
};

const SessionContext = createContext<SessionValue | null>(null);

/**
 * The session document's key on the phone. The same name it had before the store
 * moved behind the repository, so an installed app kept its own account.
 */
export const SESSION_STORAGE_KEY = 'agri-shop.session';

/**
 * The session is stored against *this device*, never against the account.
 *
 * "Which account is signed in here" is a fact about this phone. Keying it by the
 * account would mean the next person to sign in pulled the previous account's
 * session document down and was signed in as them without a code — the kind of
 * bug that is invisible until it is a security report.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const { t } = useLocale();
  const ownerId = useMemo(() => deviceOwnerId(), []);
  const document = usePersistentDocument<SessionState>({
    collection: 'session',
    ownerId,
    seed: createState,
    hydrate: (raw) => hydrate(raw),
    serialise,
  });
  const { data: state, setData: setState } = document;

  const pendingAction = useRef<(() => void) | null>(null);

  /*
   * The document as it currently stands, for the reconciliation effect below: it
   * runs outside a render, so the `state` it closed over at mount may already be
   * out of date by the time the server answers.
   */
  const stateRef = useRef(state);
  stateRef.current = state;

  /**
   * Settle who is signed in, against the server, before a screen can disagree.
   *
   * See `./reconcile` for the three mismatches this exists to end. It runs at
   * launch and whenever the app returns to the foreground, because the token can
   * expire while the phone sits in a pocket: without the second one, a farmer who
   * comes back after a day keeps a header with their name on it and a server that
   * refuses every write.
   *
   * Throttled because locale changes re-create `t`, which re-runs the effect, and
   * one RPC per keystroke of a language switch is not a reason to talk to the
   * backend. The work itself is guarded by a ref so two runs can never overlap and
   * apply conflicting verdicts.
   */
  const reconciling = useRef(false);
  const lastReconcileAt = useRef(0);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (reconciling.current) return;
      if (lastReconcileAt.current !== 0 && Date.now() - lastReconcileAt.current < 30_000) return;
      reconciling.current = true;
      lastReconcileAt.current = Date.now();
      try {
        const outcome = await reconcileSession(stateRef.current);
        if (cancelled || outcome.kind === 'unchanged') return;

        if (outcome.kind === 'party') {
          // Same farmer, now with the key every policy matches on.
          setState((current) => setPartyId(current, outcome.partyId));
          return;
        }

        if (outcome.kind === 'adopt') {
          // A session outlived the app's own record of it: take it, do not re-ask.
          setState((current) => adoptAccount(current, outcome.identity, Date.now()));
          return;
        }

        /*
         * The server has no session for this account. Signing out is the honest
         * state, and it is said out loud: an account that disappears from the
         * header with no sentence is the app being confusing in a different way.
         */
        setState((current) => signOutOf(current));
        toast.info(t('session.expired'));
      } finally {
        reconciling.current = false;
      }
    };

    void run();

    const onVisible = () => {
      // `document` is this provider's own session document — the DOM's is named
      // explicitly so a future refactor cannot quietly read the wrong one.
      if (globalThis.document.visibilityState === 'visible') void run();
    };
    globalThis.document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      globalThis.document.removeEventListener('visibilitychange', onVisible);
    };
  }, [setState, t]);

  const runPending = useCallback((after: (action: () => void) => void) => {
    const action = pendingAction.current;
    pendingAction.current = null;
    if (action) after(action);
  }, []);

  const value = useMemo<SessionValue>(
    () => ({
      account: state.account,
      isGuest: state.account === null,
      pendingReason: state.pendingReason,
      sync: document.status,
      requestIdentity: (action, reason) => {
        if (state.account) {
          action();
          return true;
        }
        pendingAction.current = action;
        setState((current) => requestAccount(current, reason));
        return false;
      },
      signIn: (input) => {
        const { state: next, result } = signInWith(state, input, Date.now());
        if (!result.ok) return result;

        /*
         * Guest farming context — crops, village, language — is already on the
         * phone, and the account adopts it rather than asking for it again. The
         * toast is the receipt: the rule says migration must be safe *and* the
         * farmer must be able to tell that it happened.
         */
        const migrated = !next.contextMigrated;
        setState(markContextMigrated(next));
        toast.success(
          migrated
            ? t('session.welcomeMigrated', { name: next.account?.name ?? '' })
            : t('session.welcome', { name: next.account?.name ?? '' }),
        );
        runPending((action) => action());
        return { ok: true };
      },
      signOut: () => {
        setState((current) => signOutOf(current));
        pendingAction.current = null;
        // The next sign-in is a new question; do not let the throttle swallow it.
        lastReconcileAt.current = 0;
      },
      prompt: (reason) => {
        pendingAction.current = null;
        setState((current) => requestAccount(current, reason));
      },
      dismiss: () => {
        pendingAction.current = null;
        setState((current) => cancelRequest(current));
      },
    }),
    [state, t, runPending, document.status, setState],
  );

  return (
    <SessionContext.Provider value={value}>
      {children}
      <CredentialSheet />
    </SessionContext.Provider>
  );
}

export function useSession() {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error('useSession must be used inside a SessionProvider');
  }
  return context;
}
