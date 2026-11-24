import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MEDIA_LIMITS,
  classifyMediaFailure,
  chooseVoiceMimeType,
  formatDuration,
  imageMimeTypeFor,
  mediaCapability,
  mediaFunctionUrl,
  mediaLink,
  readMediaRows,
  sendAttachment,
  uploadMedia,
  validateMedia,
  voiceMimeTypeFor,
  type MediaTransport,
} from './media';

const config = { url: 'https://shop.example', key: 'anon-key', configured: true };

/** Answers the shop's calls in order, and records what was sent. */
function stubShop(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: Record<string, unknown> | null;
  }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });
    const next = responses.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

const blob = (size = 2048, type = 'audio/webm;codecs=opus') => new Blob([new Uint8Array(size)], { type });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the container the shop accepts', () => {
  it('strips the codec parameter a recorder reports', () => {
    expect(voiceMimeTypeFor('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(voiceMimeTypeFor('audio/mp4;codecs=opus')).toBe('audio/mp4');
    expect(voiceMimeTypeFor('audio/ogg;codecs=opus')).toBe('audio/ogg');
  });

  it('names a container the shop does not list rather than refusing the farmer', () => {
    expect(voiceMimeTypeFor('audio/x-m4a')).toBe('audio/mp4');
    expect(voiceMimeTypeFor('audio/aac')).toBe('audio/mp4');
    expect(voiceMimeTypeFor(null)).toBe('audio/webm');
  });

  it('recognises the photos the shop takes', () => {
    expect(imageMimeTypeFor({ type: 'image/jpeg' })).toBe('image/jpeg');
    expect(imageMimeTypeFor({ type: '', name: 'PIC.PNG' })).toBe('image/png');
    expect(imageMimeTypeFor({ type: 'image/gif', name: 'a.gif' })).toBeNull();
  });

  it('asks for a container the device actually supports, in order', () => {
    expect(chooseVoiceMimeType(() => true)).toBe('audio/mp4');
    expect(chooseVoiceMimeType((type) => type === 'audio/webm')).toBe('audio/webm');
    expect(chooseVoiceMimeType(() => false)).toBeUndefined();
  });

  it('formats a duration the way a message bubble reads', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(7000)).toBe('0:07');
    expect(formatDuration(63_000)).toBe('1:03');
    expect(formatDuration(-5)).toBe('0:00');
  });

  it('names the one media door on the shop project', () => {
    expect(mediaFunctionUrl(config)).toBe('https://shop.example/functions/v1/farmer-media');
    expect(mediaFunctionUrl({ ...config, url: 'https://shop.example/' })).toBe(
      'https://shop.example/functions/v1/farmer-media',
    );
  });
});

describe('uploading', () => {
  it('posts the bytes to the media function with the farmer token', async () => {
    const transport = vi.fn<MediaTransport>(async () => ({
      ok: true,
      data: { storage_path: 'shop/farmer/uuid.webm', content_type: 'audio/webm', size_bytes: 2048 },
    }));
    const progress: number[] = [];

    const result = await uploadMedia({
      token: 'tok',
      kind: 'voice',
      blob: blob(),
      mimeType: 'audio/webm',
      durationMs: 7300,
      onProgress: (fraction) => progress.push(fraction),
      transport,
      config,
    });

    expect(result).toEqual({
      ok: true,
      data: { storagePath: 'shop/farmer/uuid.webm', mimeType: 'audio/webm', sizeBytes: 2048 },
    });

    const [url, , headers] = transport.mock.calls[0]!;
    expect(url).toBe(
      'https://shop.example/functions/v1/farmer-media?kind=voice&mime=audio%2Fwebm&duration_ms=7300',
    );
    expect(headers).toMatchObject({
      apikey: 'anon-key',
      'x-farmer-token': 'tok',
      'Content-Type': 'audio/webm',
    });
    expect(progress.at(-1)).toBe(1);
  });

  it('sends no duration for a photo, because the shop refuses one', async () => {
    const transport = vi.fn<MediaTransport>(async () => ({
      ok: true,
      data: { storage_path: 'shop/farmer/uuid.jpg' },
    }));

    await uploadMedia({
      token: 'tok',
      kind: 'image',
      blob: blob(5000, 'image/jpeg'),
      mimeType: 'image/jpeg',
      transport,
      config,
    });

    expect(transport.mock.calls[0]![0]).not.toContain('duration_ms');
  });

  it('reports a refusal in the words the screen can act on', async () => {
    const transport = vi.fn<MediaTransport>(async () => ({
      ok: false,
      error: 'unauthorized',
      message: 'that farmer token is not valid',
    }));

    const result = await uploadMedia({
      token: 'tok',
      kind: 'voice',
      blob: blob(),
      mimeType: 'audio/webm',
      durationMs: 2000,
      transport,
      config,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe('unauthorized');
  });

  it('treats a 200 with no stored path as an unfinished backend, not a retry', async () => {
    const transport = vi.fn<MediaTransport>(async () => ({ ok: true, data: { nothing: true } }));

    const result = await uploadMedia({
      token: 'tok',
      kind: 'voice',
      blob: blob(),
      mimeType: 'audio/webm',
      durationMs: 2000,
      transport,
      config,
    });

    expect(result.ok === false && result.error).toBe('unavailable');
  });

  it('maps the shop’s error vocabulary onto the app’s', () => {
    expect(classifyMediaFailure(403, { error: 'NOT_LINKED' })).toBe('not-found');
    expect(classifyMediaFailure(401, { error: 'NOT_AUTHORIZED' })).toBe('unauthorized');
    expect(classifyMediaFailure(413, { error: 'TOO_LARGE' })).toBe('validation');
    expect(classifyMediaFailure(400, { error: 'VALIDATION' })).toBe('validation');
    expect(classifyMediaFailure(500, { error: 'STORAGE_FAILED' })).toBe('unavailable');
  });
});

describe('recording the message row', () => {
  it('sends the attachment through farmer_api_send_attachment', async () => {
    const calls = stubShop([{ status: 200, body: { id: 'message-1' } }]);

    const result = await sendAttachment({
      token: 'tok',
      kind: 'voice',
      storagePath: 'shop/farmer/uuid.webm',
      mimeType: 'audio/webm',
      sizeBytes: 2048,
      durationMs: 7300,
      config,
    });

    expect(result).toEqual({ ok: true, data: { messageId: 'message-1' } });
    expect(calls[0]?.url).toBe('https://shop.example/rest/v1/rpc/farmer_api_send_attachment');
    expect(calls[0]?.body).toEqual({
      p_token: 'tok',
      p_kind: 'voice',
      p_storage_path: 'shop/farmer/uuid.webm',
      p_mime_type: 'audio/webm',
      p_size_bytes: 2048,
      p_duration_ms: 7300,
      p_body: null,
    });
  });

  it('sends null duration and the caption for a photo', async () => {
    const calls = stubShop([{ status: 200, body: { id: 'message-2' } }]);

    await sendAttachment({
      token: 'tok',
      kind: 'image',
      storagePath: 'shop/farmer/uuid.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 5000,
      durationMs: 4000,
      caption: '  the damaged bag  ',
      config,
    });

    expect(calls[0]?.body).toMatchObject({ p_duration_ms: null, p_body: 'the damaged bag' });
  });
});

describe('reading the thread’s files', () => {
  it('keeps the rows that name a message and a known kind', () => {
    expect(
      readMediaRows([
        {
          message_id: 'm1',
          kind: 'voice',
          mime_type: 'audio/webm',
          size_bytes: 4211,
          duration_ms: 4200,
          width: null,
          height: null,
        },
        { message_id: 'm2', kind: 'image', width: 800, height: 600, duration_ms: null },
        { kind: 'voice' },
        { message_id: 'm3', kind: 'video' },
      ]),
    ).toEqual([
      {
        messageId: 'm1',
        kind: 'voice',
        mimeType: 'audio/webm',
        sizeBytes: 4211,
        durationMs: 4200,
        width: null,
        height: null,
      },
      {
        messageId: 'm2',
        kind: 'image',
        mimeType: null,
        sizeBytes: null,
        durationMs: null,
        width: 800,
        height: 600,
      },
    ]);
  });

  it('reads an empty conversation as no files rather than as a failure', () => {
    expect(readMediaRows([])).toEqual([]);
    expect(readMediaRows(null)).toEqual([]);
    expect(readMediaRows({ media: [] })).toEqual([]);
  });
});

describe('links', () => {
  it('mints one for a message, with the token in the header', async () => {
    const calls = stubShop([
      { status: 200, body: { url: 'https://shop.example/signed', expires_in: 60, duration_ms: 4200 } },
    ]);

    const result = await mediaLink('tok', 'message-1', config);

    expect(result).toEqual({
      ok: true,
      data: { url: 'https://shop.example/signed', expiresIn: 60, mimeType: null, durationMs: 4200 },
    });
    expect(calls[0]?.url).toBe(
      'https://shop.example/functions/v1/farmer-media?message_id=message-1',
    );
    expect(calls[0]?.headers).toMatchObject({ 'x-farmer-token': 'tok' });
  });

  it('turns a 404 into “not found” without guessing', async () => {
    stubShop([{ status: 404, body: { error: 'NOT_FOUND' } }]);
    const result = await mediaLink('tok', 'message-9', config);
    expect(result.ok === false && result.error).toBe('not-found');
  });
});

describe('capability', () => {
  it('is true when the metadata call answers and the function is deployed', async () => {
    stubShop([
      { status: 200, body: [] },
      { status: 400, body: { error: 'VALIDATION' } },
    ]);
    await expect(mediaCapability('tok', config)).resolves.toBe(true);
  });

  it('is false on a backend without the media migration', async () => {
    stubShop([
      { status: 404, body: { code: 'PGRST202' } },
      { status: 404, body: { code: 'NOT_FOUND' } },
    ]);
    await expect(mediaCapability('tok', config)).resolves.toBe(false);
  });

  it('is false when the calls exist but the upload function does not', async () => {
    stubShop([
      { status: 200, body: [] },
      { status: 404, body: { code: 'NOT_FOUND' } },
    ]);
    await expect(mediaCapability('tok', config)).resolves.toBe(false);
  });
});

describe('what the app refuses before spending an upload', () => {
  it('refuses a tap, a note over a minute, and a nine-megabyte photo', () => {
    expect(validateMedia('voice', blob(MEDIA_LIMITS.minBytes - 1), 300).ok).toBe(false);
    expect(
      validateMedia('voice', blob(2000), MEDIA_LIMITS.maxVoiceDurationMs + 1).ok,
    ).toBe(false);
    expect(validateMedia('image', blob(MEDIA_LIMITS.maxImageBytes + 1, 'image/jpeg')).ok).toBe(
      false,
    );
    expect(validateMedia('voice', blob(2000), 4000).ok).toBe(true);
    expect(validateMedia('image', blob(2000, 'image/jpeg')).ok).toBe(true);
  });
});
