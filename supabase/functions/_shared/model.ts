/**
 * The model client.
 *
 * One module talks to the model vendor, so the key is read in exactly one place
 * and the gateway's behaviour when the model is unreachable is decided once
 * rather than at each call site.
 *
 * Two vendors are supported because both keys exist, and because the PRD's rule
 * is "do not hard-code the application to the provider". The choice is
 * configuration (`AI_PROVIDER`), and when it is unset the module picks whichever
 * key is actually present — OpenAI first, then Gemini. A build with neither key
 * reports that plainly instead of failing somewhere deeper.
 *
 * The OpenAI path also honours `OPENAI_BASE_URL`, so any OpenAI-compatible
 * gateway (OmniRoute, LiteLLM, an on-prem router) can serve the app by changing
 * one variable and a model name. A local gateway may be keyless, so a configured
 * base URL alone marks the provider as usable; a key is attached when one exists.
 *
 * Keys never leave the server. They are read from the function's environment,
 * where they were placed through the dashboard's Edge Function secrets — not from
 * the client bundle, and not from the request.
 *
 * `providerStatus()` exists so the answer to "is the key working?" is checkable
 * without ever printing the key: it reports *which* providers are configured and
 * which one is active, which is exactly what a health endpoint should say.
 */

// The Edge runtime supplies the real global. The app's TypeScript project does
// not include Deno's ambient library, so declare the narrow surface this module
// uses; the declaration is erased at runtime.
declare const Deno: { env: { get(name: string): string | undefined } };

const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';
// Gemini retired 2.0-flash. Keep the default on the supported current model;
// short answers also opt into the lower-latency thinking level explicitly.
const GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash';

export type ProviderName = 'openai' | 'gemini';

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type ModelReply = {
  ok: true;
  text: string;
  model: string;
  provider: ProviderName;
  /** How many provider calls it took, including the successful one. */
  attempts: number;
} | {
  ok: false;
  reason:
    | 'not_configured'
    | 'unreachable'
    | 'rate_limited'
    | 'refused'
    | 'empty'
    | 'malformed';
  detail: string;
  provider: ProviderName | null;
  model: string | null;
  /** HTTP status when the provider answered; absent for network/timeouts. */
  status?: number;
  /** Provider-requested wait, when a 429 carried Retry-After. */
  retryAfterMs?: number;
  attempts: number;
};

type CallFailure = {
  ok: false;
  reason: 'not_configured' | 'unreachable' | 'rate_limited' | 'refused' | 'empty' | 'malformed';
  detail: string;
  status?: number;
  retryAfterMs?: number;
};

type CallReply = { ok: true; text: string } | CallFailure;

function env(...names: string[]): string | null {
  // `typeof` keeps the module importable in a Node test runner, while the
  // direct `Deno.env.get(name)` call is what the server-secret checker verifies.
  if (typeof Deno === 'undefined') return null;
  for (const name of names) {
    const value = Deno.env.get(name);
    if (value && value.trim().length > 0) return value.trim();
  }
  return null;
}

export function openAiKey(): string | null {
  return env('OPENAI_API_KEY');
}

/**
 * The OpenAI-compatible endpoint when it has been pointed away from the vendor.
 * Null means the official OpenAI API.
 *
 * This is how a self-hosted gateway is used: set `OPENAI_BASE_URL` to e.g.
 * `http://localhost:20128/v1` (OmniRoute) and `OPENAI_MODEL=auto`. No code
 * change, no second provider implementation.
 */
export function openAiGateway(): string | null {
  const base = env('OPENAI_BASE_URL');
  return base ? base.replace(/\/+$/, '') : null;
}

/** Usable when a key exists, a gateway is configured, or both. */
function openAiUsable(): boolean {
  return openAiKey() !== null || openAiGateway() !== null;
}

export function geminiKey(): string | null {
  // Google issues the same key under two names depending on which console page
  // you copied it from, and both appear in the wild.
  return env('GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY');
}

/** Which vendor will be used, resolved from configuration then from what exists. */
export function activeProvider(): ProviderName | null {
  const requested = env('AI_PROVIDER')?.toLowerCase();
  if (requested === 'openai') return openAiUsable() ? 'openai' : null;
  if (requested === 'gemini') return geminiKey() ? 'gemini' : null;
  if (openAiUsable()) return 'openai';
  if (geminiKey()) return 'gemini';
  return null;
}

export function modelName(): string {
  const provider = activeProvider();
  if (provider === 'gemini') {
    return env('GEMINI_MODEL', 'AI_MODEL') ?? GEMINI_DEFAULT_MODEL;
  }
  return env('OPENAI_MODEL', 'AI_MODEL') ?? OPENAI_DEFAULT_MODEL;
}

export function modelConfigured(): boolean {
  return activeProvider() !== null;
}

/**
 * What the health endpoint reports.
 *
 * Booleans only — never the key, not even a prefix. A health endpoint that leaks
 * four characters of a key is a health endpoint that leaks a key.
 */
export function providerStatus(): {
  configured: boolean;
  active: ProviderName | null;
  model: string | null;
  available: Record<ProviderName, boolean>;
  /** True when an OpenAI-compatible gateway overrides the vendor URL. The URL
   *  itself is not reported, and keys never are. */
  gateway: boolean;
} {
  const active = activeProvider();
  return {
    configured: active !== null,
    active,
    model: active ? modelName() : null,
    available: { openai: openAiUsable(), gemini: geminiKey() !== null },
    gateway: openAiGateway() !== null,
  };
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* -------------------------------------------------------------------------- */
/* OpenAI                                                                     */
/* -------------------------------------------------------------------------- */

async function callOpenAi(
  messages: ChatMessage[],
  opts: { json?: boolean; temperature?: number; maxTokens?: number; signal: AbortSignal },
): Promise<CallReply> {
  const key = openAiKey();
  const gateway = openAiGateway();
  if (!key && !gateway) {
    return { ok: false, reason: 'not_configured', detail: 'OPENAI_API_KEY is not set.' };
  }
  const model = modelName();

  const base = gateway ?? 'https://api.openai.com/v1';
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // A keyless local gateway is legitimate; send the header only when a key exists.
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 700,
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: opts.signal,
  });

  if (!response.ok) {
    return {
      ok: false,
      reason: response.status === 429 ? 'rate_limited' : 'unreachable',
      detail: `OpenAI answered ${response.status}.`,
      status: response.status,
      retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
    };
  }

  let payload: {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    return { ok: false, reason: 'malformed', detail: 'OpenAI returned a malformed response.' };
  }
  const choice = payload.choices?.[0];
  const text = choice?.message?.content?.trim() ?? '';

  if (choice?.finish_reason === 'content_filter') {
    return { ok: false, reason: 'refused', detail: 'The model declined to answer.' };
  }
  if (text.length === 0) return { ok: false, reason: 'empty', detail: 'The model returned an empty answer.' };

  return { ok: true, text };
}

/* -------------------------------------------------------------------------- */
/* Gemini                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Gemini's request shape differs from OpenAI's in three ways that matter:
 * the system prompt is its own field, the assistant role is called `model`, and
 * a JSON reply is asked for through `responseMimeType` rather than
 * `response_format`. The mapping is done here so callers stay vendor-agnostic.
 */
async function callGemini(
  messages: ChatMessage[],
  opts: {
    json?: boolean;
    temperature?: number;
    maxTokens?: number;
    thinkingLevel?: 'low' | 'medium' | 'high';
    signal: AbortSignal;
  },
): Promise<CallReply> {
  const key = geminiKey();
  if (!key) return { ok: false, reason: 'not_configured', detail: 'GEMINI_API_KEY is not set.' };
  const model = modelName();

  const systemText = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');

  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents,
        ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
        generationConfig: {
          temperature: opts.temperature ?? 0.2,
          maxOutputTokens: opts.maxTokens ?? 700,
          /* Gemini 3.8 defaults to medium thinking. A short, grounded answer
             does not need that deliberation, and the default is what pushed
             the request past the gateway's 25s budget. Diagnosis leaves this
             unset so its deeper reasoning is unchanged. */
          ...(opts.thinkingLevel
            ? { thinkingConfig: { thinkingLevel: opts.thinkingLevel } }
            : {}),
          ...(opts.json ? { responseMimeType: 'application/json' } : {}),
        },
      }),
      signal: opts.signal,
    },
  );

  if (!response.ok) {
    return {
      ok: false,
      reason: response.status === 429 ? 'rate_limited' : 'unreachable',
      detail: `Gemini answered ${response.status}.`,
      status: response.status,
      retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
    };
  }

  let payload: {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
    promptFeedback?: { blockReason?: string };
  };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    return { ok: false, reason: 'malformed', detail: 'Gemini returned a malformed response.' };
  }

  if (payload.promptFeedback?.blockReason) {
    return { ok: false, reason: 'refused', detail: `Gemini blocked the prompt (${payload.promptFeedback.blockReason}).` };
  }

  const candidate = payload.candidates?.[0];
  const text =
    candidate?.content?.parts?.map((p) => p.text ?? '').join('').trim() ?? '';

  if (candidate?.finishReason === 'SAFETY') {
    return { ok: false, reason: 'refused', detail: 'The model declined to answer.' };
  }
  if (text.length === 0) return { ok: false, reason: 'empty', detail: 'The model returned an empty answer.' };

  return { ok: true, text };
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A single completion, from whichever vendor is configured.
 * `json` asks for a strict JSON object, which is how the diagnosis path gets
 * structured output without a second parsing model.
 */
export async function complete(
  messages: ChatMessage[],
  opts: {
    json?: boolean;
    temperature?: number;
    maxTokens?: number;
    /** Total budget across attempts. */
    timeoutMs?: number;
    /** Per-attempt cap; the remainder of the total budget is still respected. */
    attemptTimeoutMs?: number;
    maxAttempts?: number;
    /** Base for exponential backoff; jitter is added per attempt. */
    retryBaseMs?: number;
    thinkingLevel?: 'low' | 'medium' | 'high';
  } = {},
): Promise<ModelReply> {
  const provider = activeProvider();
  if (!provider) {
    return {
      ok: false,
      reason: 'not_configured',
      detail: 'No model provider is configured. Set OPENAI_API_KEY, GEMINI_API_KEY or OPENAI_BASE_URL as a function secret.',
      provider: null,
      model: null,
      attempts: 0,
    };
  }

  const model = modelName();
  const call = provider === 'gemini' ? callGemini : callOpenAi;
  const maxAttempts = Math.max(1, Math.min(opts.maxAttempts ?? 3, 4));
  const deadline = Date.now() + Math.max(1_000, opts.timeoutMs ?? 25_000);
  let last: CallFailure | null = null;
  let attempts = 0;

  while (attempts < maxAttempts) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    attempts += 1;
    const controller = new AbortController();
    const attemptMs = Math.min(opts.attemptTimeoutMs ?? 12_000, remaining);
    const timer = setTimeout(() => controller.abort(), attemptMs);

    try {
      const reply = await call(messages, { ...opts, signal: controller.signal });
      if (reply.ok) return { ok: true, text: reply.text, model, provider, attempts };
      last = reply;
      if (!retryable(reply) || attempts >= maxAttempts) break;
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const message = error instanceof Error ? error.message : 'unknown error';
      last = {
        ok: false,
        reason: 'unreachable',
        detail: name === 'AbortError' || /abort/i.test(message)
          ? 'The model did not answer in time.'
          : 'The model could not be reached.',
      };
      if (attempts >= maxAttempts) break;
    } finally {
      clearTimeout(timer);
    }

    const left = deadline - Date.now();
    if (left <= 0) break;
    const backoff = Math.min(opts.retryBaseMs ?? 250, 2_000) * 2 ** (attempts - 1);
    const wait = last.retryAfterMs !== undefined
      ? Math.min(last.retryAfterMs, left)
      : Math.min(backoff + Math.floor(Math.random() * 100), left);
    if (wait <= 0) continue;
    await sleep(wait);
  }

  const failure = last ?? {
    ok: false as const,
    reason: 'unreachable' as const,
    detail: 'The model did not answer in time.',
  };
  return { ...failure, provider, model, attempts };
}

function retryable(failure: CallFailure): boolean {
  if (failure.reason === 'rate_limited' || failure.reason === 'malformed' || failure.reason === 'empty') {
    return true;
  }
  if (failure.reason !== 'unreachable') return false;
  return failure.status === undefined || failure.status === 429 || failure.status >= 500;
}

/** Parses a JSON reply, tolerating a fenced block. Returns null when unusable. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    const parsed: unknown = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
