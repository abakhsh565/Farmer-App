/**
 * The model client.
 *
 * One module talks to OpenAI so that the key is read in exactly one place, and
 * so the gateway's behaviour when the model is unreachable is decided once
 * rather than at each call site.
 *
 * The key never leaves the server. It is read from the function's environment,
 * where it was placed through the dashboard's Edge Function secrets — not from
 * the client bundle, and not from the request.
 */

const DEFAULT_MODEL = 'gpt-4o-mini';

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type ModelReply = {
  ok: true;
  text: string;
  model: string;
} | {
  ok: false;
  reason: 'not_configured' | 'unreachable' | 'refused' | 'empty';
  detail: string;
};

export function modelName(): string {
  return Deno.env.get('OPENAI_MODEL') ?? DEFAULT_MODEL;
}

export function modelConfigured(): boolean {
  return Boolean(Deno.env.get('OPENAI_API_KEY'));
}

/**
 * A single completion. `json` asks the model for a strict JSON object, which is
 * how the diagnosis path gets structured output without a second parsing model.
 */
export async function complete(
  messages: ChatMessage[],
  opts: { json?: boolean; temperature?: number; maxTokens?: number; timeoutMs?: number } = {},
): Promise<ModelReply> {
  const key = Deno.env.get('OPENAI_API_KEY');
  if (!key) {
    return {
      ok: false,
      reason: 'not_configured',
      detail: 'OPENAI_API_KEY is not set for this function.',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 25_000);

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: modelName(),
        messages,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 700,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      return {
        ok: false,
        reason: 'unreachable',
        detail: `OpenAI answered ${response.status}: ${body.slice(0, 200)}`,
      };
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    };
    const choice = payload.choices?.[0];
    const text = choice?.message?.content?.trim() ?? '';

    if (choice?.finish_reason === 'content_filter') {
      return { ok: false, reason: 'refused', detail: 'The model declined to answer.' };
    }
    if (text.length === 0) {
      return { ok: false, reason: 'empty', detail: 'The model returned an empty answer.' };
    }

    return { ok: true, text, model: modelName() };
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