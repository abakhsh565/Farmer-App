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
 * Keys never leave the server. They are read from the function's environment,
 * where they were placed through the dashboard's Edge Function secrets — not from
 * the client bundle, and not from the request.
 *
 * `providerStatus()` exists so the answer to "is the key working?" is checkable
 * without ever printing the key: it reports *which* providers are configured and
 * which one is active, which is exactly what a health endpoint should say.
 */

const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';
const GEMINI_DEFAULT_MODEL = 'gemini-2.0-flash';

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
} | {
  ok: false;
  reason: 'not_configured' | 'unreachable' | 'refused' | 'empty';
  detail: string;
};

function env(...names: string[]): string | null {
  for (const name of names) {
    const value = Deno.env.get(name);
    if (value && value.trim().length > 0) return value.trim();
  }
  return null;
}

export function openAiKey(): string | null {
  return env('OPENAI_API_KEY');
}

export function geminiKey(): string | null {
  // Google issues the same key under two names depending on which console page
  // you copied it from, and both appear in the wild.
  return env('GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY');
}

/** Which vendor will be used, resolved from configuration then from what exists. */
export function activeProvider(): ProviderName | null {
  const requested = env('AI_PROVIDER')?.toLowerCase();
  if (requested === 'openai') return openAiKey() ? 'openai' : null;
  if (requested === 'gemini') return geminiKey() ? 'gemini' : null;
  if (openAiKey()) return 'openai';
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
} {
  const active = activeProvider();
  return {
    configured: active !== null,
    active,
    model: active ? modelName() : null,
    available: { openai: openAiKey() !== null, gemini: geminiKey() !== null },
  };
}

/* -------------------------------------------------------------------------- */
/* OpenAI                                                                     */
/* -------------------------------------------------------------------------- */

async function callOpenAi(
  messages: ChatMessage[],
  opts: { json?: boolean; temperature?: number; maxTokens?: number; signal: AbortSignal },
): Promise<ModelReply> {
  const key = openAiKey();
  if (!key) return { ok: false, reason: 'not_configured', detail: 'OPENAI_API_KEY is not set.' };
  const model = modelName();

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
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
    const body = await response.text();
    return { ok: false, reason: 'unreachable', detail: `OpenAI answered ${response.status}: ${body.slice(0, 200)}` };
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  };
  const choice = payload.choices?.[0];
  const text = choice?.message?.content?.trim() ?? '';

  if (choice?.finish_reason === 'content_filter') {
    return { ok: false, reason: 'refused', detail: 'The model declined to answer.' };
  }
  if (text.length === 0) return { ok: false, reason: 'empty', detail: 'The model returned an empty answer.' };

  return { ok: true, text, model, provider: 'openai' };
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
  opts: { json?: boolean; temperature?: number; maxTokens?: number; signal: AbortSignal },
): Promise<ModelReply> {
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
          ...(opts.json ? { responseMimeType: 'application/json' } : {}),
        },
      }),
      signal: opts.signal,
    },
  );

  if (!response.ok) {
    const body = await response.text();
    return { ok: false, reason: 'unreachable', detail: `Gemini answered ${response.status}: ${body.slice(0, 200)}` };
  }

  const payload = (await response.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
    promptFeedback?: { blockReason?: string };
  };

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

  return { ok: true, text, model, provider: 'gemini' };
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
  opts: { json?: boolean; temperature?: number; maxTokens?: number; timeoutMs?: number } = {},
): Promise<ModelReply> {
  const provider = activeProvider();
  if (!provider) {
    return {
      ok: false,
      reason: 'not_configured',
      detail: 'No model provider is configured. Set OPENAI_API_KEY or GEMINI_API_KEY as a function secret.',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 25_000);

  try {
    const call = provider === 'gemini' ? callGemini : callOpenAi;
    return await call(messages, { ...opts, signal: controller.signal });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error';
    return {
      ok: false,
      reason: 'unreachable',
      detail: detail.includes('abort') ? 'The model did not answer in time.' : detail,
    };
  } finally {
    clearTimeout(timer);
  }
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
