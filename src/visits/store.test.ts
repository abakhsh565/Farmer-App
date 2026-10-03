import { describe, expect, it } from 'vitest';
import {
  activeForDealer,
  createState,
  decide,
  hydrate,
  latestForDealer,
  request,
  serialise,
  type VisitData,
  type VisitRequest,
} from './store';

const NOW = 1_800_000_000_000;

/** These fixtures hold exactly one request; this names that assumption once. */
function only(data: VisitData): VisitRequest {
  return data.requests[0] as VisitRequest;
}

describe('field visit requests', () => {
  it('records a request as pending, with the dealer it was sent to', () => {
    const { data, result } = request(createState(), 'dealer.aliTraders', NOW);
    expect(result.ok).toBe(true);
    expect(only(data)).toMatchObject({
      dealerKey: 'dealer.aliTraders',
      status: 'pending',
      decidedAt: null,
    });
  });

  it('refuses a second open request to the same dealer', () => {
    const first = request(createState(), 'dealer.aliTraders', NOW).data;
    const second = request(first, 'dealer.aliTraders', NOW + 1000);
    expect(second.result).toEqual({ ok: false, error: 'visit.error.duplicate' });
    expect(second.data.requests).toHaveLength(1);
  });

  it('allows asking the same dealer again after a refusal', () => {
    const first = request(createState(), 'dealer.greenAgro', NOW).data;
    const refused = decide(first, only(first).id, 'rejected', NOW + 1).data;
    expect(activeForDealer(refused, 'dealer.greenAgro')).toBeUndefined();
    expect(request(refused, 'dealer.greenAgro', NOW + 2).result.ok).toBe(true);
  });

  it('answers only a pending request, and only once', () => {
    const data = request(createState(), 'dealer.punjabSeed', NOW).data;
    const id = only(data).id;
    const accepted = decide(data, id, 'accepted', NOW + 1).data;
    expect(latestForDealer(accepted, 'dealer.punjabSeed')).toMatchObject({
      status: 'accepted',
      decidedAt: NOW + 1,
    });
    expect(decide(accepted, id, 'rejected', NOW + 2).result.ok).toBe(false);
  });

  it('refuses an answer to a request that is gone', () => {
    expect(decide(createState(), 'visit-nothing', 'accepted', NOW).result.ok).toBe(false);
  });

  it('reads its own record back, and treats junk as empty', () => {
    const data = request(createState(), 'dealer.malikFertilizers', NOW).data;
    expect(hydrate(serialise(data))?.requests).toHaveLength(1);
    expect(hydrate('not json')).toBeNull();
    expect(hydrate('{}')).toBeNull();
  });
});
