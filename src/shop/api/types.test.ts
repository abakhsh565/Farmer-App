import { describe, expect, it } from 'vitest';
import { normaliseMe, normaliseThread } from './types';

/**
 * These fixtures are copies of what the shop's own functions returned when the
 * audit ran them, not invented shapes. That is the point: the bugs being guarded
 * against were both "this app reads a key the shop does not send".
 */

describe('normaliseMe', () => {
  it('reads the shop’s own answer: a farmer id and the shops he is linked to', () => {
    const me = normaliseMe({
      id: '348f9445-b10f-4b6f-8335-ca634f2a8879',
      name: 'Bilal',
      village: 'Layyah',
      shops: [
        { shop_id: '00000000-0000-0000-0000-000000000001', shop_name: 'Al Rehman Traders' },
      ],
    });

    expect(me).toEqual({
      farmerId: '348f9445-b10f-4b6f-8335-ca634f2a8879',
      farmerName: 'Bilal',
      shopId: '00000000-0000-0000-0000-000000000001',
      shopName: 'Al Rehman Traders',
      shopPhone: null,
    });
  });

  it('still reads the flat shape an older shop build answered with', () => {
    const me = normaliseMe({ farmer_id: 'f1', farmer_name: 'Ali', shop_id: 's1', shop_name: 'Green' });
    expect(me).toMatchObject({ farmerId: 'f1', farmerName: 'Ali', shopId: 's1', shopName: 'Green' });
  });

  it('reads a wrapped single shop', () => {
    const me = normaliseMe({ farmer_id: 'f1', shop: { id: 's2', name: 'Malik', phone: '0300' } });
    expect(me).toMatchObject({ shopId: 's2', shopName: 'Malik', shopPhone: '0300' });
  });

  it('refuses a credential that names no shop, rather than inventing one', () => {
    expect(normaliseMe({ id: 'f1', shops: [] })).toBeNull();
    expect(normaliseMe(null)).toBeNull();
  });
});

describe('normaliseThread', () => {
  const thread = {
    shop_id: 's1',
    shop_name: 'Al Rehman Traders',
    messages: [
      { id: 'm1', direction: 'farmer', channel: 'app', body: 'Joined the shop from the shop code.' },
      { id: 'm2', direction: 'farmer', channel: 'app', body: 'Cotton par spray kab karein?' },
      { id: 'm3', direction: 'owner', channel: 'app', body: 'Subah 6 se 9 baje spray karein.' },
    ],
    requests: [
      {
        id: 'r1',
        status: 'offered',
        requested_amount: 25000,
        requested_note: 'Beej ke liye',
        offer_total: 24000,
      },
    ],
    visits: [{ id: 'v1', status: 'pending', purpose: 'Spray check', preferred_window: 'Subah' }],
  };

  it('puts the farmer’s own messages on his side and the owner’s on the shop’s', () => {
    const parsed = normaliseThread(thread);
    expect(parsed.messages.map((message) => message.from)).toEqual(['me', 'me', 'dealer']);
    expect(parsed.shopName).toBe('Al Rehman Traders');
  });

  it('reads the shop’s request and visit field names', () => {
    const parsed = normaliseThread(thread);
    expect(parsed.offers[0]).toMatchObject({ id: 'r1', amount: 25000, note: 'Beej ke liye' });
    expect(parsed.visits[0]).toMatchObject({ id: 'v1', purpose: 'Spray check', window: 'Subah' });
  });

  it('drops a message with no body instead of drawing an empty bubble', () => {
    const parsed = normaliseThread({ messages: [{ id: 'x', direction: 'owner', body: '   ' }] });
    expect(parsed.messages).toEqual([]);
  });
});
