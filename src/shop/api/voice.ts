import { callShopRpc, type ShopApiResult } from './client';
import { serviceConfig, type ShopApiConfig } from '@/services/config';

/**
 * Voice notes, as this app sends them to the shop backend.
 *
 * ## Why the flow is three calls and not one
 *
 * A recording is 30–60 kB of Opus. Posting that as a parameter to a Postgres
 * function would put the bytes in the request log, in the statement timeout and in
 * the gateway's body limit, and it would give the farmer no progress at all on a
 * 2G connection. So the shop issues a *signed upload URL* for one object, the app
 * PUTs the bytes straight to storage (where progress is real), and only then tells
 * the shop "that object is a message". The shop verifies the object exists, its
 * type and its size before it becomes part of the conversation.
 *
 *   1. farmer_api_begin_voice_upload(p_token, p_mime_type, p_bytes, p_duration_ms)
 *        → { upload_url, path, expires_at }
 *   2. PUT upload_url   (Content-Type: the same mime type, raw bytes)
 *   3. farmer_api_send_voice(p_token, p_path, p_duration_ms, p_mime_type, p_bytes)
 *        → { id }
 *
 * A failure at any step leaves no message in the thread, which is the property
 * that matters: a bubble that says "sent" must exist on the shop's side too.
 *
 * ## The audio format
 *
 * Opus in an MP4 container first, because an iOS WebView writes it and an Android
 * WebView plays it; Opus in WebM second, which is what Chromium records. Both are
 * mono, 16 kHz, 32 kbps — speech, not music, and 60 seconds stays under 250 kB.
 * The picks are listed in `VOICE_MIME_TYPES` in the order the device is asked for
 * them, and the shop is told which one was recorded so it can validate rather than
 * guess from a file extension.
 */

/** What a recording may be. The shop enforces the same numbers in its own function. */
export const VOICE_LIMITS = {
  /** 60 s: long enough for a price question, short enough to upload on 2G. */
  maxDurationMs: 60_000,
  /** 4 MB is well above 60 s of Opus; anything larger is not a voice note. */
  maxBytes: 4 * 1024 * 1024,
  /** Below this a "recording" is a tap on the phone, not speech. */
  minBytes: 900,
} as const;

/**
 * Containers in the order they are tried.
 *
 * `audio/mp4;codecs=opus` is deliberately not spelled `audio/mp4` alone: on a
 * device that records AAC in MP4 the shop would receive a container it accepts but
 * a codec whose duration metadata is unreliable, and the playback bar would jump.
 */
export const VOICE_MIME_TYPES = [
  'audio/mp4;codecs=opus',
  'audio/webm;codecs=opus',
  'audio/mp4',
  'audio/webm',
  'audio/ogg;codecs=opus',
] as const;

export type VoiceMimeType = (typeof VOICE_MIME_TYPES)[number];

/** The device's best container, or `undefined` when it records none of them. */
export function chooseVoiceMimeType(
  isSupported: (type: string) => boolean = (type) =>
    typeof window !== 'undefined' && Boolean(window.MediaRecorder?.isTypeSupported?.(type)),
): VoiceMimeType | undefined {
  return VOICE_MIME_TYPES.find((type) => isSupported(type));
}

/** `0:07`, `1:03`. Minutes are not zero-padded; a voice note is never an hour. */
export function formatDuration(milliseconds: number): string {
  const total = Math.max(0, Math.round(milliseconds / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** The response of `farmer_api_begin_voice_upload`, reduced to what the app needs. */
export type VoiceUploadTicket = {
  uploadUrl: string;
  path: string;
};

/** Raw bytes → storage. Injectable so a test does not need a socket. */
export type VoiceTransport = (
  url: string,
  blob: Blob,
  mimeType: string,
  onProgress: (fraction: number) => void,
) => Promise<void>;

/**
 * Uploads through `XMLHttpRequest`, which is the only browser API that reports
 * request-body progress. `fetch` can report a download, not an upload — and an
 * upload with no progress is a spinner a farmer stares at on a bad line.
 */
export const xhrTransport: VoiceTransport = (url, blob, mimeType, onProgress) =>
  new Promise((resolve, reject) => {
    if (typeof XMLHttpRequest === 'undefined') {
      reject(new Error('This device cannot upload a recording.'));
      return;
    }

    const request = new XMLHttpRequest();
    request.open('PUT', url);
    request.setRequestHeader('Content-Type', mimeType);
    /* Some storage gateways refuse a PUT without a content length and then answer
       a 411 that reads like an auth failure. */
    request.setRequestHeader('x-upsert', 'false');

    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(1, event.loaded / event.total));
      }
    };
    request.onerror = () => reject(new Error('The recording could not be uploaded.'));
    request.ontimeout = () => reject(new Error('The upload timed out.'));
    request.onload = () =>
      request.status >= 200 && request.status < 300
        ? resolve()
        : reject(new Error(`The upload was refused (${request.status}).`));

    request.send(blob);
  });

/** Reads the ticket out of the shop's answer tolerantly: `path` or `upload_path`. */
export function readUploadTicket(value: unknown): VoiceUploadTicket | null {
  const rows = Array.isArray(value) ? value : [value];
  const row = rows.find((entry) => entry && typeof entry === 'object') as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;

  const uploadUrl =
    typeof row.upload_url === 'string'
      ? row.upload_url
      : typeof row.signed_url === 'string'
        ? row.signed_url
        : null;
  const path =
    typeof row.path === 'string'
      ? row.path
      : typeof row.upload_path === 'string'
        ? row.upload_path
        : null;

  return uploadUrl && path ? { uploadUrl, path } : null;
}

export type SendVoiceInput = {
  token: string;
  blob: Blob;
  durationMs: number;
  mimeType: string;
  onProgress?: (fraction: number) => void;
  /** Overridden in tests; the screens always use the real one. */
  transport?: VoiceTransport;
  config?: ShopApiConfig;
};

/**
 * The whole send: ticket, bytes, message.
 *
 * Returns the shop's `path` on success so the caller can retry *the same recording*
 * by starting again — the ticket has expired by then, and reusing an expired URL is
 * the one retry that would silently fail.
 */
export async function sendVoiceNote({
  token,
  blob,
  durationMs,
  mimeType,
  onProgress,
  transport = xhrTransport,
  config = serviceConfig.shopApi,
}: SendVoiceInput): Promise<ShopApiResult<{ path: string }>> {
  const bytes = blob.size;

  if (bytes < VOICE_LIMITS.minBytes) {
    return {
      ok: false,
      error: 'validation',
      message: 'That recording is too short to send.',
    };
  }
  if (bytes > VOICE_LIMITS.maxBytes || durationMs > VOICE_LIMITS.maxDurationMs) {
    return {
      ok: false,
      error: 'validation',
      message: 'That recording is too long to send.',
    };
  }

  const begun = await callShopRpc<unknown>(
    'farmer_api_begin_voice_upload',
    {
      p_token: token,
      p_mime_type: mimeType,
      p_bytes: bytes,
      p_duration_ms: Math.round(durationMs),
    },
    config,
  );

  if (!begun.ok) return begun;

  const ticket = readUploadTicket(begun.data);
  if (!ticket) {
    /* A 200 with no URL is a backend that has not finished the feature. Reporting
       it as `unavailable` rather than "try again" is the honest sentence: trying
       again would do the same thing. */
    return {
      ok: false,
      error: 'unavailable',
      message: 'The shop did not return an upload address.',
    };
  }

  try {
    await transport(ticket.uploadUrl, blob, mimeType, (fraction) => onProgress?.(fraction));
  } catch (failure) {
    return {
      ok: false,
      error: 'unavailable',
      message: failure instanceof Error ? failure.message : 'The recording could not be uploaded.',
    };
  }

  const sent = await callShopRpc<unknown>(
    'farmer_api_send_voice',
    {
      p_token: token,
      p_path: ticket.path,
      p_duration_ms: Math.round(durationMs),
      p_mime_type: mimeType,
      p_bytes: bytes,
    },
    config,
  );

  if (!sent.ok) return sent;

  onProgress?.(1);
  return { ok: true, data: { path: ticket.path } };
}

/** Whether this shop's backend answers the voice contract at all. */
export async function voiceCapability(
  token: string,
  config: ShopApiConfig = serviceConfig.shopApi,
): Promise<boolean> {
  const result = await callShopRpc<unknown>('farmer_api_voice_capability', { p_token: token }, config);
  if (!result.ok) return false;
  const rows = Array.isArray(result.data) ? result.data : [result.data];
  const row = rows.find((entry) => entry && typeof entry === 'object') as
    | Record<string, unknown>
    | undefined;
  return row?.supported === true || row?.voice === true;
}
