/**
 * Rate limit and telemetry calls for the AI gateway.
 *
 * The database owns the counters because Edge Function isolates are not a shared
 * memory. A farmer's identity is not passed in: `ai_claim_request()` and
 * `ai_finish_request()` derive it from the caller's verified JWT with
 * `current_party_id()`. The only identifier this module sends is a bounded
 * client request id, used to recognise a retried submission.
 *
 * Telemetry deliberately contains no question, image, farmer profile, crop,
 * district or citation text. It records the route, outcome, provider/model,
 * latency and counts. That is enough to operate the gateway without turning its
 * log into a copy of a farmer's conversation.
 */

type RpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
};

export type AiRoute = 'ask' | 'diagnose';

export type AiClaim =
  | {
      ok: true;
      allowed: boolean;
      eventId: string | null;
      duplicate: boolean;
      retryAfterSeconds: number | null;
    }
  | { ok: false };

export type AiFinish = {
  outcome: 'ok' | 'fallback' | 'failed';
  provider: 'openai' | 'gemini' | null;
  model: string | null;
  latencyMs: number;
  evidenceCount: number;
  citationCount: number;
  errorCode: string | null;
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max = 120): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function number(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  return null;
}

/**
 * Claim a request. A failed claim is not converted into an allow: callers must
 * treat `{ ok: false }` as unavailable rather than quietly bypassing the limit.
 */
export async function claimAiRequest(
  client: RpcClient | null,
  route: AiRoute,
  requestId: string | null,
): Promise<AiClaim> {
  if (!client) return { ok: false };
  try {
    const { data, error } = await client.rpc('ai_claim_request', {
      p_route: route,
      p_request_id: requestId,
    });
    if (error) return { ok: false };
    const row = object(data);
    if (!row || row.allowed !== true) {
      if (row?.allowed === false) {
        return {
          ok: true,
          allowed: false,
          eventId: text(row.event_id, 80),
          duplicate: row.duplicate === true,
          retryAfterSeconds: number(row.retry_after_seconds),
        };
      }
      return { ok: false };
    }
    return {
      ok: true,
      allowed: true,
      eventId: text(row.event_id, 80),
      duplicate: false,
      retryAfterSeconds: null,
    };
  } catch {
    return { ok: false };
  }
}

/**
 * Finish a claim. Telemetry must never change the answer a farmer receives, so
 * this function swallows failures. The event remains `started` if the write
 * fails, which is visible to an operator and safer than losing the answer.
 */
export async function finishAiRequest(
  client: RpcClient | null,
  eventId: string | null,
  result: AiFinish,
): Promise<void> {
  if (!client || !eventId) return;
  try {
    await client.rpc('ai_finish_request', {
      p_event_id: eventId,
      p_outcome: result.outcome,
      p_provider: result.provider,
      p_model: result.model,
      p_latency_ms: Math.max(0, Math.min(300_000, Math.round(result.latencyMs))),
      p_evidence_count: Math.max(0, Math.min(20, result.evidenceCount)),
      p_citation_count: Math.max(0, Math.min(40, result.citationCount)),
      p_error_code: result.errorCode,
    });
  } catch {
    // Deliberately silent: telemetry is optional, the answer is not.
  }
}

export async function recordAiFeedback(
  client: RpcClient | null,
  requestId: string,
  helpful: boolean,
  reason: string | null,
): Promise<boolean> {
  if (!client) return false;
  try {
    const { data, error } = await client.rpc('ai_feedback', {
      p_request_id: requestId,
      p_helpful: helpful,
      p_reason: reason,
    });
    return !error && data === true;
  } catch {
    return false;
  }
}
