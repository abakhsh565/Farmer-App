import type { MessageKey } from '@/i18n/catalog';

/**
 * Who is using the phone — as a state machine, not a boolean.
 *
 * The locked product rule is *identity-on-action*: reading the app is free, and an
 * account is asked for only at the moment an action needs an attributable owner —
 * publishing to Community, messaging a dealer, requesting credit or a field
 * visit. That makes "signed in?" the wrong question for the UI to ask. The right
 * one is "does this action need an owner, and is there one?" — which is why the
 * gated action itself (`pendingReason`) is part of the state: a farmer who taps
 * *Post* with no account must find their words still in the box after signing in,
 * not a discarded draft.
 *
 * Everything here is pure. Whether the account is real is the backend's business
 * (see `docs/PRD-ALIGNMENT.md`): this store models the *states and rules* the UI
 * must respect — guest, requested, signed in, migrated — and the demo build says
 * so on the sheet rather than pretending to send an SMS.
 */

export type Account = {
  id: string;
  name: string;
  /** Exactly one of these is set: the app supports both, per the accepted baseline. */
  phone: string | null;
  email: string | null;
  method: 'phone' | 'email';
  verifiedAt: number;
  /**
   * The domain actor this session resolves to in the database, when a real
   * backend issued the session. Null means the session exists but owns nothing
   * yet — the app can represent that state rather than pretending otherwise.
   */
  partyId: string | null;
};

export type SessionState = {
  account: Account | null;
  /** The action waiting on identity, so it can resume the moment sign-in lands. */
  pendingReason: MessageKey | null;
  /** Guest farming context carried into the account — set once, on first sign-in. */
  contextMigrated: boolean;
};

export type Result = { ok: true } | { ok: false; error: MessageKey };

export function createState(): SessionState {
  return { account: null, pendingReason: null, contextMigrated: false };
}

export function isGuest(state: SessionState): boolean {
  return state.account === null;
}

/** Tapping a gated action with no account: remember *why* before asking. */
export function requestAccount(state: SessionState, reason: MessageKey): SessionState {
  return { ...state, pendingReason: reason };
}

/** Dismissing the sheet without signing in — the action is abandoned, not half-run. */
export function cancelRequest(state: SessionState): SessionState {
  return { ...state, pendingReason: null };
}

/**
 * A Pakistani mobile number, as it is written on this side of the border:
 * eleven digits starting `03`, with spaces or dashes tolerated because nobody
 * types them the same way twice.
 */
export function isPhone(value: string): boolean {
  const digits = value.replace(/[^0-9]/g, '');
  return /^03\d{9}$/.test(digits);
}

export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
}

/**
 * The check behind the sheet's submit button. Phone or email, one at a time —
 * the accepted baseline requires both to be possible, not both to be given.
 */
export function validateContact(method: 'phone' | 'email', value: string): MessageKey | null {
  if (method === 'phone') {
    if (value.trim().length === 0) return 'session.error.phoneRequired';
    return isPhone(value) ? null : 'session.error.phone';
  }
  if (value.trim().length === 0) return 'session.error.emailRequired';
  return isEmail(value) ? null : 'session.error.email';
}

export function displayNameOf(state: SessionState): string | null {
  return state.account?.name ?? null;
}

/**
 * Signing in. The account id is derived from the contact rather than random so
 * that signing in twice with the same number is the same account — the shape a
 * server-issued identity would take, without pretending to be one.
 */
export function signIn(
  state: SessionState,
  input: { method: 'phone' | 'email'; contact: string; name?: string; partyId?: string | null },
  now: number,
): { state: SessionState; result: Result } {
  const problem = validateContact(input.method, input.contact);
  if (problem) return { state, result: { ok: false, error: problem } };

  const contact = input.contact.trim();
  const partyId = input.partyId ?? null;
  const account: Account = {
    /*
     * A server-issued party id is the account. Falling back to the contact is
     * what the demo build did when it had no server to ask; keeping that fallback
     * means a build with no backend still has a stable account, and a real one
     * never depends on how the phone number was typed.
     */
    id: partyId ?? `${input.method}:${contact.toLowerCase()}`,
    name: input.name?.trim() || defaultName(input.method, contact),
    phone: input.method === 'phone' ? contact : null,
    email: input.method === 'email' ? contact : null,
    method: input.method,
    verifiedAt: now,
    partyId,
  };

  return {
    state: { ...state, account, pendingReason: null },
    result: { ok: true },
  };
}

/** What the header shows when the farmer did not give a name: the last 4 digits. */
function defaultName(method: 'phone' | 'email', contact: string): string {
  if (method === 'phone') {
    const digits = contact.replace(/[^0-9]/g, '');
    return `****${digits.slice(-4)}`;
  }
  return contact.split('@')[0] ?? contact;
}

/**
 * Signing out keeps the account's farming context on the phone — the crops, the
 * language — because losing them would punish the farmer for signing out. It
 * drops only the identity.
 */
export function signOut(state: SessionState): SessionState {
  return { ...state, account: null, pendingReason: null };
}

export function markContextMigrated(state: SessionState): SessionState {
  return { ...state, contextMigrated: true };
}

/**
 * Record the party id learned for an account that is already signed in.
 *
 * The account id *is* the party id, because that is the row key every policy in
 * the database matches on. An account whose party id arrives late is therefore
 * not a different account — it is the same farmer with their real key, and the
 * document layer moves their work onto it (see the hand-over in
 * `services/persistence.ts`). Without this the only way to correct the key would
 * be to sign out and in again, which is exactly the moment a farmer would lose
 * what they had written.
 */
export function setPartyId(state: SessionState, partyId: string): SessionState {
  if (!state.account || state.account.partyId === partyId) return state;
  return { ...state, account: { ...state.account, id: partyId, partyId } };
}

/** Persist the identity only — never the pending action, which belongs to a flow. */
export function serialise(state: SessionState): string {
  return JSON.stringify({
    account: state.account,
    contextMigrated: state.contextMigrated,
  });
}

export function hydrate(raw: string | null): SessionState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SessionState>;
    const account = parsed.account;
    if (
      !account ||
      typeof account.id !== 'string' ||
      (account.method !== 'phone' && account.method !== 'email')
    ) {
      return null;
    }
    return {
      ...createState(),
      account: {
        ...account,
        // A document written before the party id existed restores as "no party
        // known", which the next session exchange fills in.
        partyId: typeof account.partyId === 'string' ? account.partyId : null,
      },
      contextMigrated: parsed.contextMigrated === true,
    };
  } catch {
    return null;
  }
}
