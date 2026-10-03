import type { MessageKey } from '@/i18n/catalog';

/**
 * Field visit / crop inspection requests — the third workflow, kept apart from
 * the other two on purpose.
 *
 * It is not chat and it is not credit: a farmer asks a specific shop for a visit
 * to a specific field, the shop answers, and the answer is a state rather than a
 * message buried in a thread. The locked lifecycle is deliberately short —
 * Pending → Accepted / Rejected — with the extension to Scheduled → In Progress →
 * Completed left for later rather than pre-built as empty states nobody can move.
 *
 * One open request per dealer, like credit's one-per-order rule and for the same
 * reason: pressing the button twice must not send two requests to one shop.
 */

export type VisitStatus = 'pending' | 'accepted' | 'rejected';

export type VisitRequest = {
  id: string;
  /**
   * The dealer's identity in the dealer system, not a message key.
   *
   * It used to be typed as a message key, which was true only while the dealers
   * were a fixture written in this app. A real shop has an id that arrives from
   * the dealer system, and the translated name is found from it when the app knows
   * the shop — so the key is an opaque id and the screen does the naming.
   */
  dealerKey: string;
  status: VisitStatus;
  createdAt: number;
  decidedAt: number | null;
};

export type VisitData = { requests: VisitRequest[] };

export type Result = { ok: true } | { ok: false; error: MessageKey };

export function createState(): VisitData {
  return { requests: [] };
}

export function activeForDealer(data: VisitData, dealerKey: string): VisitRequest | undefined {
  return data.requests.find(
    (request) => request.dealerKey === dealerKey && request.status === 'pending',
  );
}

export function latestForDealer(data: VisitData, dealerKey: string): VisitRequest | undefined {
  return [...data.requests].reverse().find((request) => request.dealerKey === dealerKey);
}

export function request(
  data: VisitData,
  dealerKey: string,
  now: number,
): { data: VisitData; result: Result; requestId?: string } {
  if (activeForDealer(data, dealerKey)) {
    return { data, result: { ok: false, error: 'visit.error.duplicate' } };
  }
  const id = `visit-${dealerKey}-${now}`;
  const entry: VisitRequest = {
    id,
    dealerKey,
    status: 'pending',
    createdAt: now,
    decidedAt: null,
  };
  return { data: { requests: [...data.requests, entry] }, result: { ok: true }, requestId: id };
}

/**
 * The dealer's answer. Only a pending request can be decided, and a decision is
 * final — a shop that said no says no until the farmer asks again, which is a new
 * request rather than an edit of the old one.
 */
export function decide(
  data: VisitData,
  id: string,
  outcome: 'accepted' | 'rejected',
  now: number,
): { data: VisitData; result: Result } {
  const entry = data.requests.find((request) => request.id === id);
  if (!entry) return { data, result: { ok: false, error: 'credit.error.missing' } };
  if (entry.status !== 'pending') {
    return { data, result: { ok: false, error: 'credit.error.transition' } };
  }
  return {
    data: {
      requests: data.requests.map((request) =>
        request.id === id ? { ...request, status: outcome, decidedAt: now } : request,
      ),
    },
    result: { ok: true },
  };
}

export function serialise(data: VisitData): string {
  return JSON.stringify(data);
}

export function hydrate(raw: string | null): VisitData | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as VisitData;
    if (!Array.isArray(parsed.requests)) return null;
    return parsed;
  } catch {
    return null;
  }
}
