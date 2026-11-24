import { describe, expect, it } from 'vitest';
import { normaliseThread } from './types';

/**
 * A thread that carries a voice note.
 *
 * Two properties are being pinned: a row with no `body` is no longer dropped (that
 * rule silently deleted every recording), and the side of the conversation survives
 * — a voice note the farmer sent must not render as the shop's.
 */
describe('voice rows in the shop thread', () => {
  it('keeps a voice note that has no text of its own', () => {
    const thread = normaliseThread({
      shop_name: 'Almadina shop',
      messages: [
        {
          direction: 'farmer',
          kind: 'voice',
          audio_url: 'https://shop.example/signed/a.m4a',
          duration_ms: 7300,
          mime_type: 'audio/mp4;codecs=opus',
        },
        { direction: 'owner', body: 'Price is 850.' },
      ],
    });

    expect(thread.messages).toHaveLength(2);
    expect(thread.messages[0]).toMatchObject({
      from: 'me',
      text: undefined,
      audio: {
        url: 'https://shop.example/signed/a.m4a',
        durationMs: 7300,
        mimeType: 'audio/mp4;codecs=opus',
        status: 'sent',
      },
    });
    expect(thread.messages[1]?.text).toBe('Price is 850.');
  });

  it('reads a duration given in seconds, and keeps a note whose URL is not signed yet', () => {
    const thread = normaliseThread({
      messages: [{ direction: 'owner', kind: 'voice', duration_seconds: 12 }],
    });

    expect(thread.messages[0]?.from).toBe('dealer');
    expect(thread.messages[0]?.audio).toMatchObject({ url: null, durationMs: 12_000 });
  });

  it('still drops a row that has neither text nor audio', () => {
    const thread = normaliseThread({
      messages: [{ direction: 'farmer' }, { direction: 'farmer', body: '   ' }],
    });

    expect(thread.messages).toHaveLength(0);
  });
});
