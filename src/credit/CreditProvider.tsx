import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { MessageKey } from '@/i18n/catalog';
import { ownerFor, usePersistentDocument } from '@/services/persistence';
import { useSession } from '@/session/SessionProvider';
import { CreditCenter } from './CreditSheets';
import {
  acceptDirectly,
  agreementFor,
  awaitingFarmer,
  cancel,
  counter,
  createSeed,
  expireIfDue,
  farmerDecide,
  finalDecision,
  hydrate,
  outstandingOf,
  recordPayment,
  requestById,
  serialise,
  startReview,
  submit,
  type Agreement,
  type CreditData,
  type CreditRequest,
  type Proposal,
  type Result,
} from './store';

/**
 * Holds the credit book: the requests this farmer can see, the agreements they
 * have accepted, and the one demo affordance the shop owner's side needs.
 *
 * The shop-owner transitions below — review, accept, counter, final decision —
 * exist in the farmer's app for one reason: the shop owner acts in the *dealer*
 * system, which this build does not include, and a workflow that can never move
 * past "requested" cannot be seen or tested as a workflow. They are grouped under
 * `simulate` and every surface that calls them labels them as a demo control, so
 * none of them can be mistaken for something a farmer can do. Nothing here lets
 * the farmer counter, approve themselves, or edit accepted terms: those calls do
 * not exist, rather than existing behind a hidden button.
 */

export type CreditValue = {
  data: CreditData;
  awaiting: CreditRequest[];
  open: (focusRequestId?: string | null) => void;
  submitRequest: (
    proposal: Proposal,
  ) => { ok: true; requestId: string } | { ok: false; error: MessageKey };
  farmerAnswer: (id: string, decision: 'accept' | 'reject') => Result;
  cancelRequest: (id: string) => Result;
  outstandingOf: (agreement: Agreement) => number;
  requestById: (id: string) => CreditRequest | undefined;
  agreementFor: (id: string) => Agreement | undefined;
  /** Demo-only shop-owner simulation. Never reachable from a farmer action. */
  simulate: {
    startReview: (id: string) => void;
    acceptDirectly: (id: string) => void;
    counter: (id: string, change: { amount: number; dueKey: MessageKey; fee: number }) => void;
    final: (id: string, decision: 'approve' | 'reject') => void;
    payment: (id: string, amount: number) => void;
  };
};

const CreditContext = createContext<CreditValue | null>(null);

export const CREDIT_STORAGE_KEY = 'agri-shop.credit';

export function CreditProvider({ children }: { children: ReactNode }) {
  const { account } = useSession();
  /*
   * The credit book belongs to the farmer, so it is stored against the account
   * once there is one and against the device until then. Signing in therefore
   * *migrates* the book — the request the farmer already submitted does not
   * vanish because they made an account in the middle of the negotiation.
   */
  const ownerId = useMemo(() => ownerFor(account?.id ?? null), [account?.id]);
  const document = usePersistentDocument<CreditData>({
    collection: 'credit',
    ownerId,
    seed: () => createSeed(Date.now()),
    hydrate,
    serialise,
  });
  const { data, setData } = document;
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);

  /* A waiting state lapses on its own. Checked when the app opens; a shop owner's
     counteroffer does not need a live timer to be honest, only a correct date. */
  useEffect(() => {
    setData((current) => expireIfDue(current, Date.now()));
  }, [setData]);

  const value = useMemo<CreditValue>(
    () => ({
      data,
      awaiting: awaitingFarmer(data),
      open: (focusRequestId = null) => {
        setFocus(focusRequestId);
        setOpen(true);
      },
      submitRequest: (proposal) => {
        const { data: next, result, requestId } = submit(data, proposal, Date.now());
        setData(next);
        if (result.ok && requestId) {
          setFocus(requestId);
          return { ok: true, requestId };
        }
        return result as { ok: false; error: MessageKey };
      },
      farmerAnswer: (id, decision) => {
        const { data: next, result } = farmerDecide(data, id, decision, Date.now());
        setData(next);
        return result;
      },
      cancelRequest: (id) => {
        const { data: next, result } = cancel(data, id, Date.now());
        setData(next);
        return result;
      },
      outstandingOf: (agreement) => outstandingOf(agreement, requestById(data, agreement.requestId) as CreditRequest),
      requestById: (id) => requestById(data, id),
      agreementFor: (id) => agreementFor(data, id),
      simulate: {
        startReview: (id) => setData((current) => expireIfDue(startReview(current, id, Date.now()).data, Date.now())),
        acceptDirectly: (id) =>
          setData((current) => acceptDirectly(current, id, Date.now()).data),
        counter: (id, change) => setData((current) => counter(current, id, change, Date.now()).data),
        final: (id, decision) =>
          setData((current) => finalDecision(current, id, decision, Date.now()).data),
        payment: (id, amount) =>
          setData((current) => recordPayment(current, id, { amount, noteKey: 'credit.payment.cash', at: Date.now() }).data),
      },
    }),
    [data],
  );

  return (
    <CreditContext.Provider value={value}>
      {children}
      <CreditCenter open={open} focusRequestId={focus} onOpenChange={setOpen} />
    </CreditContext.Provider>
  );
}

export function useCredit() {
  const context = useContext(CreditContext);
  if (!context) {
    throw new Error('useCredit must be used inside a CreditProvider');
  }
  return context;
}
