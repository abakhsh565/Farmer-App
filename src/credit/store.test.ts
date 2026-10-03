import { describe, expect, it } from 'vitest';
import {
  acceptDirectly,
  activeForOrder,
  agreementFor,
  awaitingFarmer,
  cancel,
  changedFields,
  counter,
  createSeed,
  currentTerms,
  expireIfDue,
  farmerDecide,
  finalDecision,
  outstandingOf,
  reconcile,
  recordPayment,
  requestById,
  startReview,
  submit,
  type Agreement,
  type CreditData,
  type CreditRequest,
  type Terms,
} from './store';

/**
 * The locked credit rules, asserted as rules.
 *
 * These are the transitions a screen must not be able to bend: one counteroffer,
 * no counter-counteroffer, consent to the *displayed* version, final approval by
 * the shop owner alone, one live request per order, and money that can never be
 * paid past zero. Every refusal is checked as a refusal, not just as an absence.
 */

const NOW = 1_800_000_000_000;

const proposal = {
  orderId: 'order-dap-1',
  dealerKey: 'dealer.aliTraders' as const,
  productKey: 'product.dap' as const,
  amount: 12_000,
  dueKey: 'credit.due.afterHarvest' as const,
  consented: true,
};

const empty: CreditData = { requests: [], agreements: [] };

/** These fixtures hold exactly one request; this names that assumption once. */
function only(data: CreditData): CreditRequest {
  return data.requests[0] as CreditRequest;
}

const oneRequest = () => submit(empty, proposal, NOW).data;

describe('submitting', () => {
  it('refuses a request the farmer has not consented to', () => {
    const { result } = submit(empty, { ...proposal, consented: false }, NOW);
    expect(result).toEqual({ ok: false, error: 'credit.error.consent' });
  });

  it('refuses a zero or missing amount', () => {
    expect(submit(empty, { ...proposal, amount: 0 }, NOW).result.ok).toBe(false);
    expect(submit(empty, { ...proposal, amount: Number.NaN }, NOW).result.ok).toBe(false);
  });

  it('stores the proposal as version 1, with the farmer’s consent named to it', () => {
    const data = oneRequest();
    const request = only(data);
    expect(request.status).toBe('requested');
    expect(currentTerms(request)).toMatchObject({ version: 1, source: 'farmer', fee: 0 });
    expect(request.consents).toEqual([{ actor: 'farmer', termsVersion: 1, at: NOW }]);
  });

  it('refuses a second live request for the same order', () => {
    const data = oneRequest();
    const again = submit(data, proposal, NOW + 1000);
    expect(again.result).toEqual({ ok: false, error: 'credit.error.duplicate' });
    expect(again.data.requests).toHaveLength(1);
  });

  it('allows a new request once the old one is terminal', () => {
    let data = oneRequest();
    data = cancel(data, only(data).id, NOW + 1).data;
    expect(activeForOrder(data, proposal.orderId)).toBeUndefined();
    expect(submit(data, proposal, NOW + 2).result.ok).toBe(true);
  });
});

describe('the one counteroffer', () => {
  const reviewed = () => {
    const data = oneRequest();
    return startReview(data, only(data).id, NOW + 1).data;
  };

  it('keeps the farmer’s version and writes the shop’s as version 2', () => {
    const data = reviewed();
    const { data: next, result } = counter(
      data,
      only(data).id,
      { amount: 12_400, dueKey: 'credit.due.december', fee: 300 },
      NOW + 2,
    );
    expect(result.ok).toBe(true);
    const request = only(next);
    expect(request.terms).toHaveLength(2);
    expect(request.terms[0]).toMatchObject({ version: 1, amount: 12_000, source: 'farmer' });
    expect(currentTerms(request)).toMatchObject({
      version: 2,
      amount: 12_400,
      fee: 300,
      source: 'shop_owner',
    });
    expect(request.status).toBe('awaiting_farmer_decision');
  });

  it('refuses a second counteroffer and says which rule stopped it', () => {
    const data = reviewed();
    const first = counter(
      data,
      only(data).id,
      { amount: 12_400, dueKey: 'credit.due.december', fee: 300 },
      NOW + 2,
    ).data;
    const second = counter(
      first,
      only(first).id,
      { amount: 13_000, dueKey: 'credit.due.december', fee: 0 },
      NOW + 3,
    );
    expect(second.result).toEqual({ ok: false, error: 'credit.error.secondCounter' });
    expect(only(second.data).terms).toHaveLength(2);
  });

  it('shows exactly which terms changed', () => {
    const data = reviewed();
    const { data: next } = counter(
      data,
      only(data).id,
      { amount: 12_400, dueKey: 'credit.due.december', fee: 300 },
      NOW + 2,
    );
    const request = only(next);
    const before = request.terms[0] as Terms;
    expect(changedFields(before, currentTerms(request))).toEqual(['amount', 'fee', 'due']);
  });

  it('refuses a counteroffer once the farmer has answered', () => {
    const data = reviewed();
    const offered = counter(
      data,
      only(data).id,
      { amount: 12_400, dueKey: 'credit.due.december', fee: 300 },
      NOW + 2,
    ).data;
    const answered = farmerDecide(offered, only(offered).id, 'accept', NOW + 3).data;
    const late = counter(
      answered,
      only(answered).id,
      { amount: 14_000, dueKey: 'credit.due.december', fee: 0 },
      NOW + 4,
    );
    expect(late.result).toEqual({ ok: false, error: 'credit.error.transition' });
  });
});

describe('the farmer’s decision', () => {
  it('accepting the counteroffer records consent to that version and does not commit', () => {
    let data = oneRequest();
    const id = only(data).id;
    data = startReview(data, id, NOW + 1).data;
    data = counter(data, id, { amount: 12_400, dueKey: 'credit.due.december', fee: 300 }, NOW + 2).data;
    const { data: answered, result } = farmerDecide(data, id, 'accept', NOW + 3);

    expect(result.ok).toBe(true);
    expect(only(answered).status).toBe('awaiting_final_approval');
    expect(only(answered).consents).toContainEqual({
      actor: 'farmer',
      termsVersion: 2,
      at: NOW + 3,
    });
    expect(answered.agreements).toHaveLength(0);
  });

  it('rejecting is terminal and cannot be re-decided', () => {
    let data = oneRequest();
    const id = only(data).id;
    data = startReview(data, id, NOW + 1).data;
    data = acceptDirectly(data, id, NOW + 2).data;
    const rejected = farmerDecide(data, id, 'reject', NOW + 3).data;
    expect(only(rejected).status).toBe('rejected');
    expect(farmerDecide(rejected, id, 'accept', NOW + 4).result).toEqual({
      ok: false,
      error: 'credit.error.transition',
    });
  });

  it('the farmer cannot answer a request that is not waiting on them', () => {
    const data = oneRequest();
    expect(farmerDecide(data, only(data).id, 'accept', NOW + 1).result).toEqual({
      ok: false,
      error: 'credit.error.transition',
    });
  });
});

describe('final approval', () => {
  const awaitingFinal = () => {
    let data = oneRequest();
    const id = only(data).id;
    data = startReview(data, id, NOW + 1).data;
    data = acceptDirectly(data, id, NOW + 2).data;
    data = farmerDecide(data, id, 'accept', NOW + 3).data;
    return data;
  };

  it('commits an agreement only on the shop owner’s final approval', () => {
    const data = awaitingFinal();
    const id = only(data).id;
    const { data: done, result } = finalDecision(data, id, 'approve', NOW + 4);

    expect(result.ok).toBe(true);
    expect(only(done).status).toBe('accepted');
    const agreement = agreementFor(done, id);
    expect(agreement).toMatchObject({ termsVersion: 1, paid: 0, closedAt: null });
    expect(agreement?.farmerConsentAt).toBe(NOW + 3);
  });

  it('does not commit when the shop owner rejects finally', () => {
    const data = awaitingFinal();
    const id = only(data).id;
    const { data: done } = finalDecision(data, id, 'reject', NOW + 4, 'credit.reason.limit');
    expect(only(done).status).toBe('rejected');
    expect(done.agreements).toHaveLength(0);
  });

  it('refuses to commit without consent to the exact version being committed', () => {
    let data = oneRequest();
    const id = only(data).id;
    data = startReview(data, id, NOW + 1).data;
    data = counter(data, id, { amount: 12_400, dueKey: 'credit.due.december', fee: 300 }, NOW + 2).data;
    data = farmerDecide(data, id, 'accept', NOW + 3).data;
    /* The consent for v2 is there — remove it to prove the check reads it. */
    data = {
      ...data,
      requests: data.requests.map((request) => ({
        ...request,
        consents: request.consents.filter((entry) => entry.termsVersion !== 2),
      })),
    };
    expect(finalDecision(data, id, 'approve', NOW + 4).result).toEqual({
      ok: false,
      error: 'credit.error.consent',
    });
  });
});

describe('terminal states', () => {
  it('an accepted agreement refuses further events', () => {
    let data = oneRequest();
    const id = only(data).id;
    data = startReview(data, id, NOW + 1).data;
    data = acceptDirectly(data, id, NOW + 2).data;
    data = farmerDecide(data, id, 'accept', NOW + 3).data;
    data = finalDecision(data, id, 'approve', NOW + 4).data;

    expect(startReview(data, id, NOW + 5).result.ok).toBe(false);
    expect(cancel(data, id, NOW + 6).result.ok).toBe(false);
    expect(
      counter(data, id, { amount: 1, dueKey: 'credit.due.december', fee: 0 }, NOW + 7).result.ok,
    ).toBe(false);
  });

  it('a request expires only after its window, and only while it is still waiting', () => {
    const data = oneRequest();
    expect(expireIfDue(data, NOW + 1).requests[0]?.status).toBe('requested');
    const later = expireIfDue(data, NOW + 8 * 24 * 60 * 60 * 1000);
    expect(later.requests[0]?.status).toBe('expired');
    expect(later.requests[0]?.events.at(-1)?.actor).toBe('system');
  });

  it('counts what is waiting on the farmer', () => {
    let data = oneRequest();
    const id = only(data).id;
    data = startReview(data, id, NOW + 1).data;
    data = acceptDirectly(data, id, NOW + 2).data;
    expect(awaitingFarmer(data).map((request) => request.id)).toEqual([id]);
  });
});

describe('money', () => {
  const agreement = () => {
    let data = oneRequest();
    const id = only(data).id;
    data = startReview(data, id, NOW + 1).data;
    data = counter(data, id, { amount: 12_400, dueKey: 'credit.due.december', fee: 300 }, NOW + 2).data;
    data = farmerDecide(data, id, 'accept', NOW + 3).data;
    data = finalDecision(data, id, 'approve', NOW + 4).data;
    return data;
  };

  it('outstanding is derived from the committed version, never typed in', () => {
    const data = agreement();
    const id = only(data).id;
    const record = agreementFor(data, id) as Agreement;
    expect(outstandingOf(record, requestById(data, id) as CreditRequest)).toBe(12_700);
  });

  it('refuses a payment larger than what is owed', () => {
    const data = agreement();
    const id = only(data).id;
    const { result } = recordPayment(data, id, {
      amount: 20_000,
      noteKey: 'credit.payment.cash',
      at: NOW + 5,
    });
    expect(result).toEqual({ ok: false, error: 'credit.error.overpay' });
  });

  it('closes the agreement when the last rupee is recorded, and refuses more', () => {
    let data = agreement();
    const id = only(data).id;
    data = recordPayment(data, id, {
      amount: 12_700,
      noteKey: 'credit.payment.cash',
      at: NOW + 5,
    }).data;
    const record = agreementFor(data, id);
    expect(record?.closedAt).toBe(NOW + 5);
    expect(
      recordPayment(data, id, { amount: 1, noteKey: 'credit.payment.cash', at: NOW + 6 }).result,
    ).toEqual({ ok: false, error: 'credit.error.closed' });
  });

  it('reconciles the stored and derived figures with no contradictions', () => {
    let data = agreement();
    const id = only(data).id;
    data = recordPayment(data, id, {
      amount: 2_000,
      noteKey: 'credit.payment.cash',
      at: NOW + 5,
    }).data;
    expect(reconcile(data)).toEqual([]);
    const record = agreementFor(data, id) as Agreement;
    expect(outstandingOf(record, requestById(data, id) as CreditRequest)).toBe(10_700);
  });
});

describe('the demo seed', () => {
  it('shows something waiting, something live and something closed', () => {
    const data = createSeed(NOW);
    expect(awaitingFarmer(data)).toHaveLength(1);
    expect(data.agreements).toHaveLength(1);
    expect(data.requests.some((request) => request.status === 'rejected')).toBe(true);
  });

  it('has no money contradictions of its own', () => {
    expect(reconcile(createSeed(NOW))).toEqual([]);
  });
});
