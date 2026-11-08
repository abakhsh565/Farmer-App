import { afterEach, describe, expect, it, vi } from 'vitest';
import { complete } from '../../supabase/functions/_shared/model';

function stubEnv(values: Record<string, string>) {
  vi.stubGlobal('Deno', {
    env: { get: (name: string) => values[name] },
  });
}

function response(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  } as Response;
}

function geminiText(text: string, status = 200) {
  return response(
    {
      candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    },
    status,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('model provider reliability', () => {
  it('reports missing credentials without calling the network', async () => {
    stubEnv({});
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    const reply = await complete([{ role: 'user', content: 'hi' }]);
    expect(reply).toMatchObject({ ok: false, reason: 'not_configured', attempts: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retries a 429 and then returns the successful reply', async () => {
    stubEnv({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'test' });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({}, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(geminiText('grounded answer'));
    vi.stubGlobal('fetch', fetch);

    const reply = await complete([{ role: 'user', content: 'q' }], {
      maxAttempts: 2,
      retryBaseMs: 1,
      timeoutMs: 1000,
      attemptTimeoutMs: 100,
    });

    expect(reply).toMatchObject({ ok: true, text: 'grounded answer', provider: 'gemini', attempts: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries a 5xx response', async () => {
    stubEnv({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'test' });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({}, 503))
      .mockResolvedValueOnce(geminiText('after retry'));
    vi.stubGlobal('fetch', fetch);

    const reply = await complete([{ role: 'user', content: 'q' }], {
      maxAttempts: 2,
      retryBaseMs: 1,
      timeoutMs: 1000,
      attemptTimeoutMs: 100,
    });
    expect(reply).toMatchObject({ ok: true, text: 'after retry', attempts: 2 });
  });

  it('does not retry a deterministic 4xx', async () => {
    stubEnv({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'test' });
    const fetch = vi.fn().mockResolvedValue(response({}, 400));
    vi.stubGlobal('fetch', fetch);

    const reply = await complete([{ role: 'user', content: 'q' }], {
      maxAttempts: 3,
      retryBaseMs: 1,
      timeoutMs: 1000,
      attemptTimeoutMs: 100,
    });
    expect(reply).toMatchObject({ ok: false, reason: 'unreachable', status: 400, attempts: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reports a malformed provider payload', async () => {
    stubEnv({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'test' });
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response);
    vi.stubGlobal('fetch', fetch);

    const reply = await complete([{ role: 'user', content: 'q' }], {
      maxAttempts: 1,
      timeoutMs: 1000,
      attemptTimeoutMs: 100,
    });
    expect(reply).toMatchObject({ ok: false, reason: 'malformed', attempts: 1 });
  });

  it('aborts a timed-out attempt and reports unreachable', async () => {
    stubEnv({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'test' });
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }));
    vi.stubGlobal('fetch', fetch);

    const reply = await complete([{ role: 'user', content: 'q' }], {
      maxAttempts: 1,
      timeoutMs: 1000,
      attemptTimeoutMs: 5,
    });
    expect(reply).toMatchObject({ ok: false, reason: 'unreachable', attempts: 1 });
  });
});
