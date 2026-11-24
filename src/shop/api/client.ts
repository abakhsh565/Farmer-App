import { serviceConfig, type ShopApiConfig } from '@/services/config';

/**
 * The shop backend, as a client.
 *
 * Every call in the shop integration contract is the same HTTP shape — a POST to
 * `{shop}/rest/v1/rpc/{name}` with the shop's *anonymous* key as the API key and
 * as the bearer, and the farmer's credential as an ordinary parameter. That is
 * worth saying out loud, because it looks like a mistake: the token travels in the
 * body, not in an Authorization header, because it is not a session the gateway
 * knows about. It is the farmer's identity inside the shop's own functions.
 *
 * Errors are translated here, once, into the four things a screen can act on. The
 * shop's functions raise `NOT_AUTHORIZED` when the credential is gone — an owner
 * re-issued an invitation, or revoked one — and that is the only failure that
 * should clear what the app has stored. Everything else is a message on screen.
 */

export type ShopApiFailure =
  /** No shop backend is configured in this build. */
  | 'unconfigured'
  /** The credential is no longer valid: ask the shop for a new invitation. */
  | 'unauthorized'
  /** The shop or the farmer is unknown to the shop backend. */
  | 'not-found'
  /** The shop backend rejected what was sent (an empty message, a bad amount). */
  | 'validation'
  /** The backend could not be reached, or has not published this call. */
  | 'unavailable';

export type ShopApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ShopApiFailure; message: string };

function failure<T>(error: ShopApiFailure, message: string): ShopApiResult<T> {
  return { ok: false, error, message };
}

/** Which failures mean "forget the credential". Only one does. */
export function isTerminal(error: ShopApiFailure): boolean {
  return error === 'unauthorized';
}

/** Maps a PostgREST error body onto the four failures above. */
export function classifyFailure(status: number, body: unknown): ShopApiFailure {
  const record = (body ?? {}) as Record<string, unknown>;
  const message = `${record.message ?? ''} ${record.details ?? ''} ${record.hint ?? ''}`;

  if (/NOT_AUTHORIZED/i.test(message)) return 'unauthorized';
  if (/NOT_FOUND/i.test(message)) return 'not-found';
  if (/VALIDATION/i.test(message)) return 'validation';

  /* PGRST202 is PostgREST saying the function does not exist. That is not the
     farmer's fault and it is not their credential's: the shop backend has not
     published the call, which is a deployment fact worth naming as such. */
  if (record.code === 'PGRST202') return 'unavailable';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'unavailable';
  if (status === 400 || status === 422) return 'validation';
  return 'unavailable';
}

const RPC_PREFIX = '/rest/v1/rpc/';

/**
 * One call, with the shared headers.
 *
 * Kept generic and exported so a test can exercise the contract against a real
 * socket instead of a mocked `fetch` — the thing worth testing is that this app
 * speaks the shop's protocol, not that a stub was called.
 */
export async function callShopRpc<T>(
  name: string,
  params: Record<string, unknown>,
  config: ShopApiConfig = serviceConfig.shopApi,
): Promise<ShopApiResult<T>> {
  if (!config.configured || !config.url || !config.key) {
    return failure('unconfigured', 'The shop backend is not configured in this build.');
  }

  const endpoint = `${config.url.replace(/\/+$/, '')}${RPC_PREFIX}${name}`;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        // Both headers carry the same public key: `apikey` is what PostgREST
        // reads, and `Authorization` is what the gateway in front of it reads.
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(params),
    });
  } catch {
    return failure('unavailable', 'The shop could not be reached.');
  }

  const text = await response.text().catch(() => '');
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const record = (parsed ?? {}) as Record<string, unknown>;
    const error = classifyFailure(response.status, parsed);
    return failure(error, String(record.message ?? `HTTP ${response.status}`));
  }

  return { ok: true, data: parsed as T };
}

/* ── the calls, one per row of the contract ───────────────────────────────── */

/** The farmer and the shop he is connected to. Also the credential's health check. */
export function farmerMe(token: string) {
  return callShopRpc<unknown>('farmer_api_me', { p_token: token });
}

/**
 * Who the farmer is, as the shop's join call records it.
 *
 * The shop has no farmer login of its own: it learns a farmer at the counter by
 * name and phone number, and the phone is the identity — `0300…`, `+92300…` and
 * `92300…` must resolve to one farmer rather than three. So the join carries all
 * three facts the shop asks for, in the parameter names its function declares.
 */
export type FarmerIdentity = {
  /** National digits without a plus (`923001234567`), as the shop normalises them. */
  phone: string;
  name: string;
  village?: string | null;
};

/**
 * Join a shop with the code from its sticker.
 *
 * A shop id is deliberately not sent: the code names the shop, and a code that
 * also had to match a client-supplied shop id would be two facts where one will do.
 *
 * The phone and the name are not optional. `farmer_api_join_shop` is declared with
 * `p_phone` and `p_name` having no defaults, so a call that omits them matches no
 * signature at all and PostgREST answers `PGRST202` — which reads as "the function
 * does not exist" and is why a join used to fail as if the shop were down.
 */
export function farmerJoinShop(
  code: string,
  identity: FarmerIdentity,
  config: ShopApiConfig = serviceConfig.shopApi,
) {
  return callShopRpc<unknown>(
    'farmer_api_join_shop',
    {
      p_code: code,
      p_phone: identity.phone,
      p_name: identity.name,
      p_village: identity.village ?? null,
    },
    config,
  );
}

/**
 * The conversation with the shop.
 *
 * `shop_id` is null on purpose: a farmer joined to one shop has exactly one
 * conversation, and the shop backend resolves it. Sending an id the app guessed
 * would let a stale id open a thread that is not his.
 */
export function farmerThread(token: string) {
  return callShopRpc<unknown>('farmer_api_thread', { p_token: token, p_shop_id: null });
}

export function farmerSendMessage(token: string, body: string) {
  return callShopRpc<unknown>('farmer_api_send_message', {
    p_token: token,
    p_body: body,
    p_shop_id: null,
  });
}

export function farmerCreateCreditRequest(token: string, amount: number, note: string | null) {
  return callShopRpc<unknown>('farmer_api_create_credit_request', {
    p_token: token,
    p_amount: amount,
    p_note: note,
    p_shop_id: null,
    p_branch_id: null,
  });
}

export function farmerRequestVisit(token: string, purpose: string | null, window: string | null) {
  return callShopRpc<unknown>('farmer_api_request_visit', {
    p_token: token,
    p_purpose: purpose,
    p_window: window,
    p_shop_id: null,
    p_branch_id: null,
  });
}

export function farmerAnswerOffer(
  token: string,
  requestId: string,
  accept: boolean,
  note: string | null,
) {
  return callShopRpc<unknown>('farmer_api_answer_offer', {
    p_token: token,
    p_request_id: requestId,
    p_accept: accept,
    p_note: note,
  });
}

export function farmerNotifications(token: string) {
  return callShopRpc<unknown>('farmer_api_notifications', { p_token: token });
}

/**
 * This phone, for push.
 *
 * Re-registered on every launch rather than once: an FCM token rotates, and the
 * shop backend moves the row instead of adding another, so a phone that is opened
 * daily never accumulates duplicates.
 */
export function farmerRegisterDevice(
  token: string,
  deviceToken: string,
  platform: 'android' | 'ios' | 'web',
) {
  return callShopRpc<unknown>('farmer_api_register_device', {
    p_token: token,
    p_device_token: deviceToken,
    p_platform: platform,
  });
}
