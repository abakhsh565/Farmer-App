import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useLocale } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/catalog';
import { deviceOwnerId, usePersistentDocument, type SyncStatus } from '@/services/persistence';
import { IdentitySheet } from './IdentitySheet';
import {
  cancelRequest,
  createState,
  hydrate,
  markContextMigrated,
  requestAccount,
  serialise,
  signIn as signInWith,
  signOut as signOutOf,
  type Account,
  type Result,
  type SessionState,
} from './store';

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
 */

export type SessionValue = {
  account: Account | null;
  isGuest: boolean;
  /** Runs now and returns true; opens the sheet and returns false otherwise. */
  requestIdentity: (action: () => void, reason: MessageKey) => boolean;
  signIn: (input: { method: 'phone' | 'email'; contact: string; name?: string }) => Result;
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
    [state, t, runPending, document.status],
  );

  return (
    <SessionContext.Provider value={value}>
      {children}
      <IdentitySheet />
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
