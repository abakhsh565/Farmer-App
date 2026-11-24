import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  VOICE_LIMITS,
  chooseVoiceMimeType,
  formatDuration,
  readUploadTicket,
  sendVoiceNote,
  voiceCapability,
  type VoiceTransport,
} from './voice';

const config = { url: 'https://shop.example', key: 'anon-key', configured: true };

/** Answers the shop's calls in order, and records what was sent. */
function stubShop(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
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

const blob = (size = 2048) => new Blob([new Uint8Array(size)], { type: 'audio/mp4' });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('voice limits and format', () => {
  it('formats a duration the way a message bubble reads', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(7000)).toBe('0:07');
    expect(formatDuration(63_000)).toBe('1:03');
    expect(formatDuration(-5)).toBe('0:00');
  });

  it('asks for Opus in MP4 before Opus in WebM, and falls back in order', () => {
    expect(chooseVoiceMimeType(() => true)).toBe('audio/mp4;codecs=opus');
    expect(chooseVoiceMimeType((type) => type.startsWith('audio/webm'))).toBe(
      'audio/webm;codecs=opus',
    );
    expect(chooseVoiceMimeType(() => false)).toBeUndefined();
  });

  it('reads both ticket shapes the shop may answer with', () => {
    expect(readUploadTicket({ upload_url: 'https://s/x', path: 'a/b.m4a' })).toEqual({
      uploadUrl: 'https://s/x',
      path: 'a/b.m4a',
    });
    expect(readUploadTicket([{ signed_url: 'https://s/y', upload_path: 'c/d.webm' }])).toEqual({
      uploadUrl: 'https://s/y',
      path: 'c/d.webm',
    });
    expect(readUploadTicket({ upload_url: 'https://s/x' })).toBeNull();
    expect(readUploadTicket(null)).toBeNull();
  });
});

describe('sending a voice note', () => {
  it('takes a ticket, PUTs the bytes, then tells the shop which object is the message', async () => {
    const calls = stubShop([
      { status: 200, body: { upload_url: 'https://storage.example/one', path: 'farmer/one.m4a' } },
      { status: 200, body: { id: 'message-1' } },
    ]);

    const uploaded: Array<{ url: string; bytes: number; mimeType: string }> = [];
    const transport: VoiceTransport = async (url, body, mimeType) => {
      uploaded.push({ url, bytes: body.size, mimeType });
    };
    const progress: number[] = [];

    const result = await sendVoiceNote({
      token: 'tok',
      blob: blob(2048),
      durationMs: 7300,
      mimeType: 'audio/mp4;codecs=opus',
      onProgress: (fraction) => progress.push(fraction),
      transport,
      config,
    });

    expect(result).toEqual({ ok: true, data: { path: 'farmer/one.m4a' } });
    expect(calls.map((call) => call.url.split('/').pop())).toEqual([
      'farmer_api_begin_voice_upload',
      'farmer_api_send_voice',
    ]);
    expect(calls[0]?.body).toEqual({
      p_token: 'tok',
      p_mime_type: 'audio/mp4;codecs=opus',
      p_bytes: 2048,
      p_duration_ms: 7300,
    });
    expect(calls[1]?.body).toEqual({
      p_token: 'tok',
      p_path: 'farmer/one.m4a',
      p_duration_ms: 7300,
      p_mime_type: 'audio/mp4;codecs=opus',
      p_bytes: 2048,
    });
    /* The bytes went to the signed URL, not to the RPC. */
    expect(uploaded).toEqual([
      { url: 'https://storage.example/one', bytes: 2048, mimeType: 'audio/mp4;codecs=opus' },
    ]);
    expect(progress.at(-1)).toBe(1);
  });

  it('does not upload anything when the shop refuses the ticket', async () => {
    stubShop([{ status: 404, body: { code: 'PGRST202', message: 'function not found' } }]);
    const transport = vi.fn<VoiceTransport>(async () => undefined);

    const result = await sendVoiceNote({
      token: 'tok',
      blob: blob(),
      durationMs: 2000,
      mimeType: 'audio/webm;codecs=opus',
      transport,
      config,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe('unavailable');
    expect(transport).not.toHaveBeenCalled();
  });

  it('reports a failed upload without creating a message', async () => {
    const calls = stubShop([
      { status: 200, body: { upload_url: 'https://storage.example/two', path: 'farmer/two.m4a' } },
    ]);
    const transport: VoiceTransport = async () => {
      throw new Error('The upload timed out.');
    };

    const result = await sendVoiceNote({
      token: 'tok',
      blob: blob(),
      durationMs: 2000,
      mimeType: 'audio/mp4',
      transport,
      config,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toBe('The upload timed out.');
    /* Only the ticket call happened: `send_voice` must not run for bytes that never
       arrived, or the thread would hold a message pointing at nothing. */
    expect(calls).toHaveLength(1);
  });

  it('refuses a recording that is too short or too long before calling the shop', async () => {
    const calls = stubShop([]);

    const short = await sendVoiceNote({
      token: 'tok',
      blob: blob(VOICE_LIMITS.minBytes - 1),
      durationMs: 300,
      mimeType: 'audio/mp4',
      transport: async () => undefined,
      config,
    });
    const long = await sendVoiceNote({
      token: 'tok',
      blob: blob(),
      durationMs: VOICE_LIMITS.maxDurationMs + 1,
      mimeType: 'audio/mp4',
      transport: async () => undefined,
      config,
    });

    expect(short.ok).toBe(false);
    expect(long.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('treats a shop without the voice calls as unsupported, not as broken', async () => {
    stubShop([{ status: 404, body: { code: 'PGRST202', message: 'function not found' } }]);
    await expect(voiceCapability('tok', config)).resolves.toBe(false);

    stubShop([{ status: 200, body: { supported: true } }]);
    await expect(voiceCapability('tok', config)).resolves.toBe(true);
  });
});
