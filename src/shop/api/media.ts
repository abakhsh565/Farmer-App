import { callShopRpc, classifyFailure, type ShopApiFailure, type ShopApiResult } from './client';
import { serviceConfig, type ShopApiConfig } from '@/services/config';

/**
 * Voice notes and photos, as the shop's backend actually takes them.
 *
 * ## The contract is the shop's, not ours
 *
 * `docs/MEDIA-CONTRACT.md` records it. The short version, because every line here
 * exists to match it and a change on that side is a change here:
 *
 *   1. POST {shop}/functions/v1/farmer-media?kind=voice&mime=audio/webm&duration_ms=4200
 *        headers: apikey, x-farmer-token, Content-Type
 *        body:    the raw bytes
 *        → { storage_path, content_type, size_bytes }
 *   2. farmer_api_send_attachment(p_token, p_kind, p_storage_path, p_mime_type,
 *                                 p_size_bytes, p_duration_ms, p_body)
 *        → { id, created_at, direction, attachment }
 *   3. farmer_api_media(p_token, p_shop_id)     — every file in the thread, once
 *        → [{ message_id, kind, mime_type, size_bytes, duration_ms, width, height, … }]
 *   4. GET {shop}/functions/v1/farmer-media?message_id=<uuid>
 *        → { url, expires_in, duration_ms, mime_type, kind, sender }
 *
 * Two things follow from that shape and are worth stating.
 *
 * **The bytes never travel as an RPC parameter.** They go to one function as the
 * request body, which is the only way an upload on a 2G line can report real
 * progress, and the only way a 4 MB recording does not become a 4 MB statement
 * argument.
 *
 * **The playable URL is minted, not stored.** It is a sixty-second signature on a
 * private object, so it is asked for when the farmer presses play and never kept in
 * a message. A bubble therefore renders from metadata alone, which is why step 3
 * carries the duration: a thread of twenty notes must not download twenty files to
 * draw itself.
 *
 * ## The audio format
 *
 * Opus in an MP4 container or in WebM — whatever the device's own recorder writes —
 * mono, 32 kbps, at most a minute. The shop accepts only the *bare* container name
 * (`audio/webm`), while a recorder reports the codec too
 * (`audio/webm;codecs=opus`), so the codec parameter is stripped before the upload:
 * sending the full string is answered with `400 VALIDATION unsupported mime type`,
 * which reads like a broken phone rather than a one-line mismatch.
 */

/** What a file may be. The shop enforces its own numbers; these are the app's. */
export const MEDIA_LIMITS = {
  /** 60 s: long enough for a price question, short enough to upload on 2G. */
  maxVoiceDurationMs: 60_000,
  /** Below this a "recording" is a tap on the phone, not speech. */
  minBytes: 900,
  /** 4 MB is well above 60 s of Opus; anything larger is not a voice note. */
  maxVoiceBytes: 4 * 1024 * 1024,
  /** The shop's own ceiling is 10 MB; a phone photo that big is a mistake. */
  maxImageBytes: 8 * 1024 * 1024,
} as const;

/** Everything the shop's media bucket accepts, as bare container names. */
export const VOICE_MIME_TYPES = ['audio/mp4', 'audio/webm', 'audio/ogg', 'audio/mpeg'] as const;
export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type MediaKind = 'voice' | 'image';

/**
 * The container name the shop knows, from whatever the device reports.
 *
 * `audio/mp4;codecs=opus` → `audio/mp4`. A recorder that names a container the shop
 * does not list (`audio/x-m4a`, `audio/aac`) is still recording MPEG-4 audio, so it
 * is named as MP4 rather than refused: the farmer did nothing wrong.
 */
export function containerType(recorded: string | null | undefined): string | null {
  if (!recorded) return null;
  const base = recorded.split(';')[0]?.trim().toLowerCase() ?? '';
  return base.startsWith('audio/') || base.startsWith('image/') ? base : null;
}

/** The mime type to send for a recording, always one the shop accepts. */
export function voiceMimeTypeFor(recorded: string | null | undefined): string {
  const base = containerType(recorded);
  if (base && (VOICE_MIME_TYPES as readonly string[]).includes(base)) return base;
  if (base === 'audio/x-m4a' || base === 'audio/aac' || base === 'audio/mp4a-latm') {
    return 'audio/mp4';
  }
  return 'audio/webm';
}

/** The mime type to send for a photo, or `null` when the shop would refuse it. */
export function imageMimeTypeFor(file: { type?: string; name?: string }): string | null {
  const base = containerType(file.type);
  if (base && (IMAGE_MIME_TYPES as readonly string[]).includes(base)) return base;
  const name = (file.name ?? '').toLowerCase();
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  return null;
}

/**
 * Whether this device can record at all, so the microphone is only drawn where it
 * can be used.
 *
 * Kept here rather than borrowed from the speech/transcription module: that module
 * is about turning an utterance into text and carries an endpoint, a twelve-second
 * cap and a transcription call, none of which a voice note wants or should inherit.
 */
export function voiceRecordingSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof window !== 'undefined' &&
    typeof window.MediaRecorder !== 'undefined'
  );
}

/** The device's preferred container, or `undefined` when it records none of them. */
export function chooseVoiceMimeType(
  isSupported: (type: string) => boolean = (type) =>
    typeof window !== 'undefined' && Boolean(window.MediaRecorder?.isTypeSupported?.(type)),
): string | undefined {
  return VOICE_MIME_TYPES.find((type) => isSupported(type));
}

/** `0:07`, `1:03`. Minutes are not zero-padded; a voice note is never an hour. */
export function formatDuration(milliseconds: number): string {
  const total = Math.max(0, Math.round(milliseconds / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** The one media door on the shop project. */
export function mediaFunctionUrl(config: ShopApiConfig = serviceConfig.shopApi): string | null {
  if (!config.url) return null;
  return `${config.url.replace(/\/+$/, '')}/functions/v1/farmer-media`;
}

/** A media row of the thread, as `farmer_api_media` returns it. */
export type ShopMediaRow = {
  messageId: string;
  kind: MediaKind;
  mimeType: string | null;
  sizeBytes: number | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asNumber(value: unknown): number | null {
  /* `Number(null)` and `Number('')` are both 0, which would turn "no duration" into
     "a zero-second recording" — a bubble that says 0:00 for a real note. */
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * The thread's files, read tolerantly.
 *
 * `farmer_api_media` answers `[]` for a conversation of plain text, and that is not
 * an error: a client written for text keeps working. A row that names no message or
 * an unknown kind is skipped rather than guessed at.
 */
export function readMediaRows(value: unknown): ShopMediaRow[] {
  const source = Array.isArray(value)
    ? value
    : Array.isArray(record(value).media)
      ? (record(value).media as unknown[])
      : [];

  return source
    .map((entry) => {
      const row = record(entry);
      const messageId = typeof row.message_id === 'string' ? row.message_id : null;
      const kind = (typeof row.kind === 'string' ? row.kind : '').toLowerCase();
      if (!messageId || (kind !== 'voice' && kind !== 'image')) return null;
      return {
        messageId,
        kind: kind as MediaKind,
        mimeType: typeof row.mime_type === 'string' ? row.mime_type : null,
        sizeBytes: asNumber(row.size_bytes),
        durationMs: asNumber(row.duration_ms),
        width: asNumber(row.width),
        height: asNumber(row.height),
      } satisfies ShopMediaRow;
    })
    .filter((row): row is ShopMediaRow => row !== null);
}

/** Raw bytes → the shop's function. Injectable so a test needs no socket. */
export type MediaTransport = (
  url: string,
  blob: Blob,
  headers: Record<string, string>,
  onProgress: (fraction: number) => void,
) => Promise<ShopApiResult<unknown>>;

/** The shop's own error vocabulary, mapped onto the four states a screen acts on. */
export function classifyMediaFailure(status: number, body: unknown): ShopApiFailure {
  const row = record(body);
  const code = String(row.error ?? '').toUpperCase();
  if (code === 'NOT_AUTHORIZED') return 'unauthorized';
  if (code === 'NOT_LINKED' || code === 'NOT_FOUND') return 'not-found';
  if (code === 'VALIDATION' || code === 'TOO_LARGE') return 'validation';
  return classifyFailure(status, body);
}

/**
 * Uploads through `XMLHttpRequest`, which is the only browser API that reports
 * request-body progress. `fetch` can report a download, not an upload — and an
 * upload with no progress is a spinner a farmer stares at on a bad line.
 */
export const xhrUpload: MediaTransport = (url, blob, headers, onProgress) =>
  new Promise((resolve) => {
    if (typeof XMLHttpRequest === 'undefined') {
      resolve({ ok: false, error: 'unavailable', message: 'This device cannot send a file.' });
      return;
    }

    const request = new XMLHttpRequest();
    request.open('POST', url);
    for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);

    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(1, event.loaded / event.total));
      }
    };
    request.onerror = () =>
      resolve({ ok: false, error: 'unavailable', message: 'The upload could not be completed.' });
    request.ontimeout = () =>
      resolve({ ok: false, error: 'unavailable', message: 'The upload timed out.' });
    request.onload = () => {
      let body: unknown = null;
      try {
        body = request.responseText ? JSON.parse(request.responseText) : null;
      } catch {
        body = null;
      }
      if (request.status >= 200 && request.status < 300) {
        resolve({ ok: true, data: body });
        return;
      }
      resolve({
        ok: false,
        error: classifyMediaFailure(request.status, body),
        message: String(record(body).message ?? `The upload was refused (${request.status}).`),
      });
    };

    request.send(blob);
  });

export type UploadedMedia = {
  /** `<shop_id>/<farmer_id>/<uuid>.<ext>`, chosen by the shop, never by the app. */
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
};

export type UploadMediaInput = {
  token: string;
  kind: MediaKind;
  blob: Blob;
  mimeType: string;
  /** Only for a voice note. The shop refuses a note without one. */
  durationMs?: number;
  onProgress?: (fraction: number) => void;
  transport?: MediaTransport;
  config?: ShopApiConfig;
};

/** Step 1: the bytes, to the shop's one media function. */
export async function uploadMedia({
  token,
  kind,
  blob,
  mimeType,
  durationMs,
  onProgress,
  transport = xhrUpload,
  config = serviceConfig.shopApi,
}: UploadMediaInput): Promise<ShopApiResult<UploadedMedia>> {
  const endpoint = mediaFunctionUrl(config);
  if (!config.configured || !endpoint || !config.key) {
    return { ok: false, error: 'unconfigured', message: 'The shop backend is not configured in this build.' };
  }

  const query = new URLSearchParams({ kind, mime: mimeType });
  if (kind === 'voice') query.set('duration_ms', String(Math.max(1, Math.round(durationMs ?? 0))));

  const result = await transport(
    `${endpoint}?${query.toString()}`,
    blob,
    {
      apikey: config.key,
      'x-farmer-token': token,
      'Content-Type': mimeType,
      Accept: 'application/json',
    },
    (fraction) => onProgress?.(fraction),
  );

  if (!result.ok) return result;

  const row = record(result.data);
  const storagePath = typeof row.storage_path === 'string' ? row.storage_path : null;
  if (!storagePath) {
    /* A 200 with no path is a function that has not finished the feature. Naming it
       as unavailable rather than "try again" is the honest sentence: a retry would
       do exactly the same thing. */
    return { ok: false, error: 'unavailable', message: 'The shop did not return a stored file.' };
  }

  onProgress?.(1);
  return {
    ok: true,
    data: {
      storagePath,
      mimeType: typeof row.content_type === 'string' ? row.content_type : mimeType,
      sizeBytes: asNumber(row.size_bytes) ?? blob.size,
    },
  };
}

export type SendAttachmentInput = {
  token: string;
  kind: MediaKind;
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
  durationMs?: number;
  caption?: string | null;
  /** The shop whose conversation this file belongs to; null means the credential's. */
  shopId?: string | null;
  config?: ShopApiConfig;
};

/** Step 2: the conversation row that makes the object a message. */
export async function sendAttachment({
  token,
  kind,
  storagePath,
  mimeType,
  sizeBytes,
  durationMs,
  caption,
  shopId = null,
  config = serviceConfig.shopApi,
}: SendAttachmentInput): Promise<ShopApiResult<{ messageId: string | null }>> {
  const result = await callShopRpc<unknown>(
    'farmer_api_send_attachment',
    {
      p_token: token,
      p_kind: kind,
      p_storage_path: storagePath,
      p_mime_type: mimeType,
      p_size_bytes: Math.round(sizeBytes),
      /* An image carries no duration at all — the shop's own check refuses one. */
      p_duration_ms: kind === 'voice' ? Math.max(1, Math.round(durationMs ?? 0)) : null,
      p_body: caption && caption.trim() ? caption.trim() : null,
      /* Which counter this file was sent to. The shop checks that the object is in
         *this* conversation, so a photo taken while reading one shop's thread can
         never surface in another's. */
      p_shop_id: shopId,
    },
    config,
  );

  if (!result.ok) return result;

  const row = record(Array.isArray(result.data) ? result.data[0] : result.data);
  return { ok: true, data: { messageId: typeof row.id === 'string' ? row.id : null } };
}

/**
 * The app's own sanity checks, before anything is uploaded.
 *
 * The shop repeats them (`400 VALIDATION`), and that is not duplication to remove:
 * a farmer on a 2G line should learn that a 9 MB photo is too large without spending
 * the upload to find out.
 */
export function validateMedia(
  kind: MediaKind,
  blob: Blob,
  durationMs = 0,
): ShopApiResult<true> {
  if (kind === 'voice') {
    if (blob.size < MEDIA_LIMITS.minBytes) {
      return { ok: false, error: 'validation', message: 'That recording is too short to send.' };
    }
    if (blob.size > MEDIA_LIMITS.maxVoiceBytes || durationMs > MEDIA_LIMITS.maxVoiceDurationMs) {
      return { ok: false, error: 'validation', message: 'That recording is too long to send.' };
    }
    return { ok: true, data: true };
  }

  if (blob.size === 0) {
    return { ok: false, error: 'validation', message: 'That photo is empty.' };
  }
  if (blob.size > MEDIA_LIMITS.maxImageBytes) {
    return { ok: false, error: 'validation', message: 'That photo is too large to send.' };
  }
  return { ok: true, data: true };
}

/** Step 3: every file in the conversation, once per thread. */
export async function fetchShopMedia(
  token: string,
  config: ShopApiConfig = serviceConfig.shopApi,
): Promise<ShopApiResult<ShopMediaRow[]>> {
  const result = await callShopRpc<unknown>('farmer_api_media', { p_token: token, p_shop_id: null }, config);
  if (!result.ok) return result;
  return { ok: true, data: readMediaRows(result.data) };
}

export type MediaLink = {
  url: string;
  /** Seconds the signature stays valid — the shop says sixty. */
  expiresIn: number;
  mimeType: string | null;
  durationMs: number | null;
};

/**
 * Step 4: a short-lived URL for one message, minted when it is needed.
 *
 * Cached until shortly before it expires, because tapping play twice on a song-length
 * note must not mint two signatures — but never longer than the signature lives, since
 * a stored URL is a link that works and then stops working with no explanation.
 */
export async function mediaLink(
  token: string,
  messageId: string,
  config: ShopApiConfig = serviceConfig.shopApi,
): Promise<ShopApiResult<MediaLink>> {
  const endpoint = mediaFunctionUrl(config);
  if (!config.configured || !endpoint || !config.key) {
    return { ok: false, error: 'unconfigured', message: 'The shop backend is not configured in this build.' };
  }

  let response: Response;
  try {
    response = await fetch(`${endpoint}?message_id=${encodeURIComponent(messageId)}`, {
      method: 'GET',
      headers: { apikey: config.key, 'x-farmer-token': token, Accept: 'application/json' },
    });
  } catch {
    return { ok: false, error: 'unavailable', message: 'The shop could not be reached.' };
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
    return {
      ok: false,
      error: classifyMediaFailure(response.status, parsed),
      message: String(record(parsed).message ?? `HTTP ${response.status}`),
    };
  }

  const row = record(parsed);
  const url = typeof row.url === 'string' ? row.url : null;
  if (!url) return { ok: false, error: 'unavailable', message: 'The shop did not return a link.' };

  return {
    ok: true,
    data: {
      url,
      expiresIn: asNumber(row.expires_in) ?? 60,
      mimeType: typeof row.mime_type === 'string' ? row.mime_type : null,
      durationMs: asNumber(row.duration_ms),
    },
  };
}

/**
 * Whether this shop takes voice notes and photos at all.
 *
 * Asked once per connected session rather than assumed: a control that records a
 * message the shop cannot accept is worse than no control, because the farmer talks
 * for thirty seconds and loses it. Both halves are checked, because they ship
 * together: the metadata call proves the migration is applied, and the function
 * proves the bytes have somewhere to go. An older backend fails the first with
 * `PGRST202`, which reads as "not supported" here and as an outage nowhere.
 */
export async function mediaCapability(
  token: string,
  config: ShopApiConfig = serviceConfig.shopApi,
): Promise<boolean> {
  const [metadata, door] = await Promise.all([
    fetchShopMedia(token, config),
    (async () => {
      const endpoint = mediaFunctionUrl(config);
      if (!endpoint || !config.key) return false;
      try {
        /* Deliberately without a `message_id`: the function answers `400 VALIDATION`
           ("message_id is required") when it is deployed, and the project answers
           `404 NOT_FOUND` when it is not. Nothing is uploaded or signed. */
        const response = await fetch(endpoint, {
          method: 'GET',
          headers: { apikey: config.key, 'x-farmer-token': token, Accept: 'application/json' },
        });
        return response.status === 400;
      } catch {
        return false;
      }
    })(),
  ]);

  return metadata.ok && door;
}
