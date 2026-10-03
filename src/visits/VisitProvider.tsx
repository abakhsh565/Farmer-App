import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { ownerFor, usePersistentDocument } from '@/services/persistence';
import { useSession } from '@/session/SessionProvider';
import {
  activeForDealer,
  createState,
  decide,
  hydrate,
  latestForDealer,
  request,
  serialise,
  type Result,
  type VisitData,
  type VisitRequest,
} from './store';

/**
 * Field-visit requests on the phone.
 *
 * Same split as credit: the farmer can ask and can see the answer, and the buttons
 * that produce the shop's answer live under `simulate`, labelled as the dealer's
 * side of the demo. Nothing a farmer can tap decides their own request.
 */

export type VisitValue = {
  forDealer: (dealerKey: string) => VisitRequest | undefined;
  openForDealer: (dealerKey: string) => VisitRequest | undefined;
  requestVisit: (dealerKey: string) => Result;
  /** Demo-only dealer answers. */
  simulate: { decide: (id: string, outcome: 'accepted' | 'rejected') => void };
};

const VisitContext = createContext<VisitValue | null>(null);

export const VISIT_STORAGE_KEY = 'agri-shop.visits';

export function VisitProvider({ children }: { children: ReactNode }) {
  const { account } = useSession();
  /* Field-visit requests are the farmer's, so they migrate to the account with
     the rest of their context on sign-in. */
  const ownerId = useMemo(() => ownerFor(account?.id ?? null), [account?.id]);
  const document = usePersistentDocument<VisitData>({
    collection: 'visits',
    ownerId,
    seed: createState,
    hydrate: (raw) => hydrate(raw),
    serialise,
  });
  const { data, setData } = document;

  const value = useMemo<VisitValue>(
    () => ({
      forDealer: (dealerKey) => latestForDealer(data, dealerKey),
      openForDealer: (dealerKey) => activeForDealer(data, dealerKey),
      requestVisit: (dealerKey) => {
        const { data: next, result } = request(data, dealerKey, Date.now());
        setData(next);
        return result;
      },
      simulate: {
        decide: (id, outcome) => setData((current) => decide(current, id, outcome, Date.now()).data),
      },
    }),
    [data],
  );

  return <VisitContext.Provider value={value}>{children}</VisitContext.Provider>;
}

export function useVisits() {
  const context = useContext(VisitContext);
  if (!context) {
    throw new Error('useVisits must be used inside a VisitProvider');
  }
  return context;
}
