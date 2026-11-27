import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/data/chat';
import { deliveryOf } from './messageStatus';

const mine = (patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 1,
  from: 'me',
  text: 'Assalam o alaikum',
  ...patch,
});

describe('deliveryOf', () => {
  it('has nothing to say about the shop’s messages', () => {
    expect(deliveryOf({ id: 2, from: 'dealer', text: 'Walaikum assalam' })).toBeNull();
  });

  it('reports a file still uploading as sending, before any server time exists', () => {
    expect(
      deliveryOf(
        mine({ audio: { url: null, durationMs: 4200, status: 'sending', progress: 0.4 } }),
      ),
    ).toBe('sending');
  });

  it('reports a refused file as failed', () => {
    expect(
      deliveryOf(mine({ image: { url: null, status: 'failed', localId: 'm-1' } })),
    ).toBe('failed');
  });

  it('counts a row in the shop’s thread as delivered even without its own receipt', () => {
    expect(deliveryOf(mine({ sentAt: '2026-11-27T18:41:27.864Z' }))).toBe('delivered');
  });

  it('reads a shop receipt as read, and is the only way to get there', () => {
    expect(
      deliveryOf(mine({ sentAt: '2026-11-27T18:41:27.864Z', readAt: '2026-11-27T18:42:00Z' })),
    ).toBe('read');
  });

  it('does not invent a state for a local message the shop never confirmed', () => {
    expect(deliveryOf(mine())).toBeNull();
  });
});
