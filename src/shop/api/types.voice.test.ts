import { describe, expect, it } from 'vitest';
import { normaliseThread } from './types';
import type { ShopMediaRow } from './media';

/**
 * A thread that carries files.
 *
 * The shop keeps the two halves apart on purpose: `farmer_api_thread` says who said
 * what, `farmer_api_media` says which messages carry a voice note or a photo and how
 * long the recording runs. What is pinned here is the join between them — a message
 * with no `body` is still a message once it has a file, the side of the conversation
 * survives, and a message with no attachment is an ordinary message.
 */
const voice: ShopMediaRow = {
  messageId: 'm1',
  kind: 'voice',
  mimeType: 'audio/webm',
  sizeBytes: 4211,
  durationMs: 4200,
  width: null,
  height: null,
};

const photo: ShopMediaRow = {
  messageId: 'm3',
  kind: 'image',
  mimeType: 'image/jpeg',
  sizeBytes: 90_000,
  durationMs: null,
  width: 800,
  height: 600,
};

describe('files in the shop thread', () => {
  it('joins the media call onto the messages by id', () => {
    const thread = normaliseThread(
      {
        shop_name: 'Almadina shop',
        messages: [
          { id: 'm1', direction: 'farmer', body: '' },
          { id: 'm2', direction: 'owner', body: 'Price is 850.' },
          { id: 'm3', direction: 'owner', body: '' },
        ],
      },
      [voice, photo],
    );

    expect(thread.messages).toHaveLength(3);
    expect(thread.messages[0]).toMatchObject({
      from: 'me',
      serverId: 'm1',
      text: undefined,
      audio: {
        /* Never a stored link: the shop mints sixty-second signatures on demand. */
        url: null,
        durationMs: 4200,
        mimeType: 'audio/webm',
        status: 'sent',
        serverId: 'm1',
      },
    });
    expect(thread.messages[1]?.text).toBe('Price is 850.');
    expect(thread.messages[1]?.audio).toBeUndefined();
    expect(thread.messages[2]).toMatchObject({
      from: 'dealer',
      serverId: 'm3',
      image: { url: null, mimeType: 'image/jpeg', width: 800, height: 600, status: 'sent' },
    });
  });

  it('keeps a caption on a photo as the message text', () => {
    const thread = normaliseThread(
      { messages: [{ id: 'm3', direction: 'farmer', body: 'the damaged bag' }] },
      [photo],
    );

    expect(thread.messages[0]).toMatchObject({
      text: 'the damaged bag',
      image: { mimeType: 'image/jpeg' },
    });
  });

  it('still reads a row that carries its own link, for a backend that answers that way', () => {
    const thread = normaliseThread({
      messages: [
        {
          direction: 'owner',
          kind: 'voice',
          audio_url: 'https://shop.example/signed/a.m4a',
          duration_ms: 7300,
          mime_type: 'audio/mp4',
        },
      ],
    });

    expect(thread.messages[0]).toMatchObject({
      from: 'dealer',
      audio: { url: 'https://shop.example/signed/a.m4a', durationMs: 7300, status: 'sent' },
    });
  });

  it('reads a duration given in seconds when that is all there is', () => {
    const thread = normaliseThread({
      messages: [{ direction: 'owner', kind: 'voice', duration_seconds: 12 }],
    });

    expect(thread.messages[0]?.audio).toMatchObject({ url: null, durationMs: 12_000 });
  });

  it('drops a row that has neither text nor a file', () => {
    const thread = normaliseThread({
      messages: [{ direction: 'farmer' }, { direction: 'farmer', body: '   ' }],
    });

    expect(thread.messages).toHaveLength(0);
  });

  it('leaves a text thread alone when the shop has no media at all', () => {
    const thread = normaliseThread({
      messages: [{ id: 'm9', direction: 'farmer', body: 'Salam' }],
    });

    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]?.audio).toBeUndefined();
    expect(thread.messages[0]?.image).toBeUndefined();
  });
});
