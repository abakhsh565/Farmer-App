import type { MessageKey } from '@/i18n/catalog';

/**
 * Merchant credit, as the locked state machine — one request, at most one
 * counteroffer, farmer accept/reject, then final Shop Owner approval, and only
 * that approval commits anything.
 *
 *   Requested → Shop Owner Reviewing → [Accepted directly | Counteroffered]
 *   → Awaiting Farmer Decision → Awaiting Shop Owner Final Approval
 *   → Accepted / Rejected
 *
 * The rules that this file exists to hold, and that a screen must not be able to
 * bend:
 *  · The farm proposal and the shop offer are *separate stored versions*. A
 *    counteroffer never edits version 1; version 2 is a new record, so what the
 *    farmer originally proposed survives the negotiation.
 *  · The farmer consents twice — to version 1 before submitting, and to the
 *    changed version before accepting it. Both consents name the version, an
 *    actor and a timestamp; that is the audit record the product promises.
 *  · At most one counteroffer. There is no negotiation engine, and a second
 *    counteroffer is a rejected transition, not a hidden feature.
 *  · Only the shop owner's *final* approval commits; farmer acceptance moves the
 *    request to awaiting-final-approval and nothing more.
 *  · One active request per order. Retrying the form cannot produce two live
 *    requests for the same purchase.
 *  · Terminal means terminal: accepted, rejected, cancelled and expired requests
 *    refuse every further event.
 *
 * Amounts live in whole rupees. The platform facilitates; it does not lend, so
 * nothing here invents eligibility, interest or penalties — the shop owner sets
 * commercial terms, and the app's job is to show them exactly and record them.
 */

export type CreditStatus =
  | 'requested'
  | 'reviewing'
  | 'awaiting_farmer_decision'
  | 'awaiting_final_approval'
  | 'accepted'
  | 'rejected'
  | 'cancelled'
  | 'expired';

export type TermSource = 'farmer' | 'shop_owner';

export type Terms = {
  /** 1 is what the farmer proposed; 2 is the shop owner's one counteroffer. */
  version: number;
  source: TermSource;
  amount: number;
  dueKey: MessageKey;
  /** Zero is still a written term: hidden fees are the thing this prevents. */
  fee: number;
  feeNoteKey: MessageKey | null;
};

export type Consent = { actor: 'farmer'; termsVersion: number; at: number };

export type CreditEventType =
  | 'submitted'
  | 'review_started'
  | 'accepted_directly'
  | 'counteroffered'
  | 'farmer_accepted'
  | 'farmer_rejected'
  | 'final_approved'
  | 'final_rejected'
  | 'cancelled'
  | 'expired';

export type CreditEvent = {
  id: string;
  type: CreditEventType;
  actor: 'farmer' | 'shop_owner' | 'system';
  at: number;
  termsVersion: number;
  reasonKey?: MessageKey;
};

export type CreditRequest = {
  id: string;
  orderId: string;
  dealerKey: MessageKey;
  productKey: MessageKey;
  status: CreditStatus;
  terms: Terms[];
  consents: Consent[];
  events: CreditEvent[];
  counterofferUsed: boolean;
  createdAt: number;
  /** When the current waiting state lapses; null means no window was set. */
  expiresAt: number | null;
};

export type Payment = { id: string; at: number; amount: number; noteKey: MessageKey };

export type Agreement = {
  requestId: string;
  termsVersion: number;
  farmerConsentAt: number;
  shopOwnerApprovedAt: number;
  paid: number;
  payments: Payment[];
  closedAt: number | null;
};

export type CreditData = { requests: CreditRequest[]; agreements: Agreement[] };

export type Result = { ok: true } | { ok: false; error: MessageKey };

const OK: Result = { ok: true };

/** The order the workflow moves through, for timelines and tests alike. */
export const STATUS_ORDER: readonly CreditStatus[] = [
  'requested',
  'reviewing',
  'awaiting_farmer_decision',
  'awaiting_final_approval',
  'accepted',
];

export const TERMINAL: readonly CreditStatus[] = ['accepted', 'rejected', 'cancelled', 'expired'];

export function isTerminal(status: CreditStatus): boolean {
  return TERMINAL.includes(status);
}

/** A request still able to change — the unit of duplicate protection. */
export function isActive(status: CreditStatus): boolean {
  return !isTerminal(status);
}

export function currentTerms(request: CreditRequest): Terms {
  return request.terms[request.terms.length - 1] as Terms;
}

export function totalOf(terms: Terms): number {
  return terms.amount + terms.fee;
}

export function outstandingOf(agreement: Agreement, request: CreditRequest): number {
  return totalOf(request.terms.find((entry) => entry.version === agreement.termsVersion) as Terms)
    - agreement.paid;
}

/**
 * How many shops may hold the farmer's open credit at once.
 *
 * Asking is open — a farmer can put a request to as many shops as their area
 * offers, which is the point of shopping around. *Owing* is not: credit is
 * carried at four shops at a time, so a fifth shop's request is refused while
 * four agreements are open. The cap is on credit held, not on requests made, and
 * clearing one agreement frees the place — which is why the check is here, on
 * committed money, and not on the request list.
 *
 * A shop that already holds credit is always allowed to ask again: the limit is
 * on the number of creditors, never on the farmer's own shop.
 */
export const MAX_CREDIT_SHOPS = 4;

/** The shops holding the farmer's open credit — one entry per shop, not per purchase. */
export function shopsHoldingCredit(data: CreditData): MessageKey[] {
  const shops = new Set<MessageKey>();
  for (const agreement of data.agreements) {
    if (agreement.closedAt !== null) continue;
    const request = requestById(data, agreement.requestId);
    if (request) shops.add(request.dealerKey);
  }
  return [...shops];
}

export function activeForOrder(data: CreditData, orderId: string): CreditRequest | undefined {
  return data.requests.find((request) => request.orderId === orderId && isActive(request.status));
}

export function requestById(data: CreditData, id: string): CreditRequest | undefined {
  return data.requests.find((request) => request.id === id);
}

export function agreementFor(data: CreditData, requestId: string): Agreement | undefined {
  return data.agreements.find((agreement) => agreement.requestId === requestId);
}

/** What is waiting on the farmer — the badge that says money needs an answer. */
export function awaitingFarmer(data: CreditData): CreditRequest[] {
  return data.requests.filter((request) => request.status === 'awaiting_farmer_decision');
}

/**
 * Exactly which terms moved between two versions. The farmer is told *what*
 * changed, not merely that something did — "the amount went up 800 and a 400
 * fee appeared" is consent; "terms changed" is a trap.
 */
export function changedFields(previous: Terms, next: Terms): Array<'amount' | 'fee' | 'due'> {
  const changed: Array<'amount' | 'fee' | 'due'> = [];
  if (previous.amount !== next.amount) changed.push('amount');
  if (previous.fee !== next.fee) changed.push('fee');
  if (previous.dueKey !== next.dueKey) changed.push('due');
  return changed;
}

function event(
  request: CreditRequest,
  type: CreditEventType,
  actor: CreditEvent['actor'],
  at: number,
  reasonKey?: MessageKey,
): CreditEvent {
  return {
    id: `${request.id}-${type}-${at}`,
    type,
    actor,
    at,
    termsVersion: currentTerms(request).version,
    reasonKey,
  };
}

function replace(data: CreditData, next: CreditRequest): CreditData {
  return {
    ...data,
    requests: data.requests.map((request) => (request.id === next.id ? next : request)),
  };
}

/** A transition the current status does not allow is refused, never coerced. */
function transition(data: CreditData, id: string, allowed: CreditStatus[], change: (request: CreditRequest) => CreditRequest): { data: CreditData; result: Result } {
  const request = requestById(data, id);
  if (!request) return { data, result: { ok: false, error: 'credit.error.missing' } };
  if (!allowed.includes(request.status)) {
    return { data, result: { ok: false, error: 'credit.error.transition' } };
  }
  return { data: replace(data, change(request)), result: OK };
}

export type Proposal = {
  orderId: string;
  dealerKey: MessageKey;
  productKey: MessageKey;
  amount: number;
  dueKey: MessageKey;
  /** The farmer must have ticked consent to the displayed version. */
  consented: boolean;
};

export function submit(
  data: CreditData,
  proposal: Proposal,
  now: number,
): { data: CreditData; result: Result; requestId?: string } {
  if (!proposal.consented) return { data, result: { ok: false, error: 'credit.error.consent' } };
  if (!Number.isFinite(proposal.amount) || proposal.amount <= 0) {
    return { data, result: { ok: false, error: 'credit.error.amount' } };
  }
  if (activeForOrder(data, proposal.orderId)) {
    return { data, result: { ok: false, error: 'credit.error.duplicate' } };
  }
  const holders = shopsHoldingCredit(data);
  if (holders.length >= MAX_CREDIT_SHOPS && !holders.includes(proposal.dealerKey)) {
    return { data, result: { ok: false, error: 'credit.error.shopLimit' } };
  }

  const id = `credit-${proposal.orderId}-${now}`;
  const request: CreditRequest = {
    id,
    orderId: proposal.orderId,
    dealerKey: proposal.dealerKey,
    productKey: proposal.productKey,
    status: 'requested',
    terms: [
      {
        version: 1,
        source: 'farmer',
        amount: proposal.amount,
        dueKey: proposal.dueKey,
        fee: 0,
        feeNoteKey: null,
      },
    ],
    consents: [{ actor: 'farmer', termsVersion: 1, at: now }],
    events: [],
    counterofferUsed: false,
    createdAt: now,
    /* The shop owner works from the dealer system, not this app; the window is
       generous because a village shop may take a day or two to open the app. */
    expiresAt: now + 7 * 24 * 60 * 60 * 1000,
  };
  request.events = [event(request, 'submitted', 'farmer', now)];

  return {
    data: { ...data, requests: [request, ...data.requests] },
    result: OK,
    requestId: id,
  };
}

export function startReview(data: CreditData, id: string, now: number) {
  return transition(data, id, ['requested'], (request) => ({
    ...request,
    status: 'reviewing',
    events: [...request.events, event(request, 'review_started', 'shop_owner', now)],
  }));
}

/** The shop owner accepts the farmer's own version — the terms do not move. */
export function acceptDirectly(data: CreditData, id: string, now: number) {
  return transition(data, id, ['reviewing'], (request) => ({
    ...request,
    status: 'awaiting_farmer_decision',
    events: [...request.events, event(request, 'accepted_directly', 'shop_owner', now)],
  }));
}

/**
 * The one permitted counteroffer. It writes a *new* version; version 1 is left
 * exactly as the farmer submitted it.
 */
export function counter(
  data: CreditData,
  id: string,
  change: { amount: number; dueKey: MessageKey; fee: number; feeNoteKey?: MessageKey | null },
  now: number,
): { data: CreditData; result: Result } {
  const request = requestById(data, id);
  if (!request) return { data, result: { ok: false, error: 'credit.error.missing' } };
  /*
   * A shop owner may only counter from review — or *again while the farmer is
   * deciding*, which is the case the rule is actually about. Reporting that as
   * "only one counteroffer is allowed" rather than a generic transition error is
   * the difference between a rule and a shrug.
   */
  if (request.status !== 'reviewing' && request.status !== 'awaiting_farmer_decision') {
    return { data, result: { ok: false, error: 'credit.error.transition' } };
  }
  if (request.counterofferUsed) {
    return { data, result: { ok: false, error: 'credit.error.secondCounter' } };
  }
  if (!Number.isFinite(change.amount) || change.amount <= 0) {
    return { data, result: { ok: false, error: 'credit.error.amount' } };
  }

  const previous = currentTerms(request);
  const next: Terms = {
    version: previous.version + 1,
    source: 'shop_owner',
    amount: change.amount,
    dueKey: change.dueKey,
    fee: Math.max(0, change.fee),
    feeNoteKey: change.fee > 0 ? (change.feeNoteKey ?? 'credit.fee.service') : null,
  };

  return {
    data: replace(data, {
      ...request,
      status: 'awaiting_farmer_decision',
      terms: [...request.terms, next],
      counterofferUsed: true,
      events: [...request.events, event({ ...request, terms: [...request.terms, next] }, 'counteroffered', 'shop_owner', now)],
    }),
    result: OK,
  };
}

/**
 * The farmer's answer. Accepting records consent to the *current* version — the
 * counteroffer, if there is one — and moves to final approval without committing
 * anything. Rejecting is terminal.
 */
export function farmerDecide(
  data: CreditData,
  id: string,
  decision: 'accept' | 'reject',
  now: number,
): { data: CreditData; result: Result } {
  const request = requestById(data, id);
  if (!request) return { data, result: { ok: false, error: 'credit.error.missing' } };
  if (request.status !== 'awaiting_farmer_decision') {
    return { data, result: { ok: false, error: 'credit.error.transition' } };
  }

  const terms = currentTerms(request);

  if (decision === 'reject') {
    return {
      data: replace(data, {
        ...request,
        status: 'rejected',
        expiresAt: null,
        events: [...request.events, event(request, 'farmer_rejected', 'farmer', now)],
      }),
      result: OK,
    };
  }

  return {
    data: replace(data, {
      ...request,
      status: 'awaiting_final_approval',
      consents: [...request.consents, { actor: 'farmer', termsVersion: terms.version, at: now }],
      events: [...request.events, event(request, 'farmer_accepted', 'farmer', now)],
    }),
    result: OK,
  };
}

/**
 * The committing step, and the only one that creates an agreement. The agreement
 * is a record of the exact version the farmer consented to — it is not editable,
 * and later amounts are payments against it, never rewrites of it.
 */
export function finalDecision(
  data: CreditData,
  id: string,
  decision: 'approve' | 'reject',
  now: number,
  reasonKey?: MessageKey,
): { data: CreditData; result: Result } {
  const request = requestById(data, id);
  if (!request) return { data, result: { ok: false, error: 'credit.error.missing' } };
  if (request.status !== 'awaiting_final_approval') {
    return { data, result: { ok: false, error: 'credit.error.transition' } };
  }

  if (decision === 'reject') {
    return {
      data: replace(data, {
        ...request,
        status: 'rejected',
        expiresAt: null,
        events: [
          ...request.events,
          event(request, 'final_rejected', 'shop_owner', now, reasonKey ?? 'credit.reason.notAgreed'),
        ],
      }),
      result: OK,
    };
  }

  const terms = currentTerms(request);
  const consent = [...request.consents]
    .reverse()
    .find((entry) => entry.termsVersion === terms.version);
  if (!consent) {
    /* Commit without the farmer's consent to this exact version is the one thing
       final approval must never be able to do. */
    return { data, result: { ok: false, error: 'credit.error.consent' } };
  }

  const agreement: Agreement = {
    requestId: request.id,
    termsVersion: terms.version,
    farmerConsentAt: consent.at,
    shopOwnerApprovedAt: now,
    paid: 0,
    payments: [],
    closedAt: null,
  };

  return {
    data: {
      ...replace(data, {
        ...request,
        status: 'accepted',
        expiresAt: null,
        events: [...request.events, event(request, 'final_approved', 'shop_owner', now)],
      }),
      agreements: [agreement, ...data.agreements],
    },
    result: OK,
  };
}

/** A request is withdrawn only before either side has committed to an answer. */
export function cancel(data: CreditData, id: string, now: number) {
  return transition(data, id, ['requested', 'reviewing'], (request) => ({
    ...request,
    status: 'cancelled',
    expiresAt: null,
    events: [...request.events, event(request, 'cancelled', 'farmer', now)],
  }));
}

/** Expiry is the system's event: a waiting state lapses, a committed one never does. */
export function expireIfDue(data: CreditData, now: number): CreditData {
  let changed = false;
  const requests = data.requests.map((request) => {
    if (!isActive(request.status) || request.expiresAt === null || request.expiresAt > now) {
      return request;
    }
    changed = true;
    return {
      ...request,
      status: 'expired' as CreditStatus,
      expiresAt: null,
      events: [...request.events, event(request, 'expired', 'system', now, 'credit.reason.expired')],
    };
  });
  return changed ? { ...data, requests } : data;
}

/**
 * Payments are synchronized from the dealer's business records — a read model.
 * They are accepted here so the ledger has one source in the demo, and they
 * enforce the invariant the product states out loud: paid can never exceed the
 * amount that is actually owed.
 */
export function recordPayment(
  data: CreditData,
  requestId: string,
  payment: { amount: number; noteKey: MessageKey; at: number },
): { data: CreditData; result: Result } {
  const agreement = agreementFor(data, requestId);
  const request = requestById(data, requestId);
  if (!agreement || !request) return { data, result: { ok: false, error: 'credit.error.missing' } };
  if (agreement.closedAt !== null) {
    return { data, result: { ok: false, error: 'credit.error.closed' } };
  }
  if (!Number.isFinite(payment.amount) || payment.amount <= 0) {
    return { data, result: { ok: false, error: 'credit.error.amount' } };
  }

  const outstanding = outstandingOf(agreement, request);
  if (payment.amount > outstanding) {
    return { data, result: { ok: false, error: 'credit.error.overpay' } };
  }

  const paid = agreement.paid + payment.amount;
  const next: Agreement = {
    ...agreement,
    paid,
    payments: [
      ...agreement.payments,
      {
        id: `${requestId}-pay-${payment.at}`,
        at: payment.at,
        amount: payment.amount,
        noteKey: payment.noteKey,
      },
    ],
    closedAt: paid === totalOf(currentTerms(request)) ? payment.at : null,
  };

  return {
    data: {
      ...data,
      agreements: data.agreements.map((entry) => (entry.requestId === requestId ? next : entry)),
    },
    result: OK,
  };
}

export type Reconciliation = { requestId: string; issue: 'overpaid' | 'balance-mismatch' };

/**
 * Stored-versus-derived check, in the spirit of the verification rules: the
 * outstanding figure is never typed in, and this proves it. Any row returned here
 * is a defect, not a warning.
 */
export function reconcile(data: CreditData): Reconciliation[] {
  const issues: Reconciliation[] = [];
  for (const agreement of data.agreements) {
    const request = requestById(data, agreement.requestId);
    if (!request) continue;
    const terms = request.terms.find((entry) => entry.version === agreement.termsVersion);
    if (!terms) continue;
    const total = totalOf(terms);
    if (agreement.paid > total) issues.push({ requestId: agreement.requestId, issue: 'overpaid' });
    const settled = agreement.paid === total;
    if (settled !== (agreement.closedAt !== null)) {
      issues.push({ requestId: agreement.requestId, issue: 'balance-mismatch' });
    }
  }
  return issues;
}

/**
 * A farmer starts with an empty credit book.
 *
 * This used to be a demo fixture — three requests and an agreement with a
 * balance — so the ledger would have something in it on first launch. On a
 * shared phone that meant the next person saw borrowed money that was not
 * theirs, with a due date and a history of it, which is the worst possible thing
 * to show someone who cannot tell it is a fixture. A credit record exists when
 * the farmer asks for credit; the screen's empty state is the honest first
 * launch.
 */
export function createState(): CreditData {
  return { requests: [], agreements: [] };
}

export function serialise(data: CreditData): string {
  return JSON.stringify(data);
}

export function hydrate(raw: string | null, now: number): CreditData | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CreditData;
    if (!Array.isArray(parsed.requests) || !Array.isArray(parsed.agreements)) return null;
    return expireIfDue(parsed, now);
  } catch {
    return null;
  }
}
