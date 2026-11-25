/**
 * Speech in, Urdu text out.
 *
 * The farmer's microphone needs this because the browser's own recogniser is not
 * a capability the app can rely on: Chrome's `webkitSpeechRecognition` on desktop
 * ships without a speech service behind it, so `start()` succeeds and then nothing
 * is ever heard — the microphone looks pressed, says "Listening…", and no words
 * arrive. That was measured in this app's own preview before this file existed.
 *
 * So the app records a few seconds of audio and sends it here. `GEMINI_API_KEY`
 * stays server-side, exactly as it does for the voice, because anything the
 * browser can read is compiled into the JavaScript and shipped inside the APK.
 *
 * Three rules, inherited from the voice endpoint:
 *
 *  · **Urdu or nothing.** The instruction asks for Urdu script and forbids
 *    translation; a transcript in the wrong language is worse than no transcript,
 *    because the farmer cannot tell a misheard word from a wrong one.
 *  · **A spent quota is not a broken app.** The models carry separate free-tier
 *    quotas; a 429 tries the next model and only then reports `transcribe-busy`.
 *  · **Nothing is logged.** Not the audio, not the transcript, not the key.
 *
 * Refusals are machine codes:
 *
 *   503 transcribe-not-configured  the deployment has no GEMINI_API_KEY yet
 *   502 transcribe-upstream-failed the provider answered, but not with words
 *   429 transcribe-busy            every model's free-tier limit was hit
 *   400 audio-required             nothing usable was sent
 *   405 method-not-allowed         anything but POST
 */

import type { HandlerRequest, HandlerResponse } from './tts';

/**
 * Models that accept audio input, best first.
 *
 * `gemini-3.5-transcribe` is the purpose-built one and is tried first. The flash
 * models are the fallback because they are multimodal and cheap; they were in this
 * account's own model list when this was written, which is why they are named
 * rather than guessed.
 */
const MODELS = [
  process.env.GEMINI_TRANSCRIBE_MODEL ?? 'gemini-3.5-transcribe',
  'gemini-2.5-flash',
  'gemini-3.8-flash',
].filter((model, index, all) => model.length > 0 && all.indexOf(model) === index);

/** Base64 characters, not bytes — about 6 MB of audio, far more than one sentence. */
const MAX_AUDIO_CHARS = 8 * 1024 * 1024;

/**
 * What the model is told.
 *
 * Written as an instruction to a person who will write down what they heard: the
 * speaker is a farmer in Punjab, the words go into Urdu script, and the reply is
 * the transcript and nothing else. The "no translation" clause is the important
 * one — a model that translates instead of transcribing answers a question nobody
 * asked, and the farmer then reads a sentence they never said.
 */
const INSTRUCTION = [
  'Transcribe this voice recording word for word.',
  'The speaker is a farmer in Punjab, Pakistan, speaking Urdu (possibly with Punjabi words).',
  'Write the transcript in Urdu script, exactly as spoken.',
  'Do not translate, do not summarise, do not add commentary, do not use quotation marks.',
  'If you hear no speech at all, reply with nothing.',
].join(' ');

type Body = { audio?: unknown; mimeType?: unknown; language?: unknown };

function readBody(body: unknown): Body {
  if (typeof body === 'string') {
    try {
      return JSON.parse(body) as Body;
    } catch {
      return {};
    }
  }
  if (body && typeof body === 'object') return body as Body;
  return {};
}

/** The transcript out of one generateContent reply, or null. */
function transcriptOf(payload: unknown): string | null {
  const parts = (
    payload as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    } | null
  )?.candidates?.[0]?.content?.parts;

  if (!Array.isArray(parts)) return null;
  const text = parts.map((part) => part?.text ?? '').join(' ').trim();
  return text.length > 0 ? text : '';
}

export default async function handler(req: HandlerRequest, res: HandlerResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'method-not-allowed' });
    return;
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    res.status(503).json({ error: 'transcribe-not-configured' });
    return;
  }

  const { audio, mimeType } = readBody(req.body);
  const data = typeof audio === 'string' ? audio.trim() : '';
  if (data.length === 0 || data.length > MAX_AUDIO_CHARS) {
    res.status(400).json({ error: 'audio-required', maxChars: MAX_AUDIO_CHARS });
    return;
  }

  /* Browsers disagree about the container (Chrome writes webm/opus, Safari mp4),
     so the caller states it and a sane default covers a caller that does not. */
  const mime = typeof mimeType === 'string' && mimeType.includes('/') ? mimeType : 'audio/webm';

  const request = JSON.stringify({
    contents: [
      {
        parts: [
          { inlineData: { mimeType: mime, data } },
          { text: INSTRUCTION },
        ],
      },
    ],
    generationConfig: { temperature: 0 },
  });

  let transcript: string | null = null;
  let exhausted = 0;
  let lastStatus: number | string | null = null;

  for (const model of MODELS) {
    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: request,
      },
    ).catch(() => null);

    if (!upstream) {
      lastStatus = 'unreachable';
      continue;
    }

    /* Per-model quotas: a 429 is worth another model, any other refusal is not. */
    if (upstream.status === 429) {
      exhausted += 1;
      continue;
    }

    if (!upstream.ok) {
      lastStatus = upstream.status;
      continue;
    }

    const payload = await upstream.json().catch(() => null);
    const words = transcriptOf(payload);
    if (words === null) {
      lastStatus = 'no-words';
      continue;
    }

    transcript = words;
    break;
  }

  if (transcript === null) {
    if (exhausted > 0 && exhausted === MODELS.length) {
      res.status(429).json({ error: 'transcribe-busy' });
      return;
    }
    res.status(502).json({ error: 'transcribe-upstream-failed', reason: lastStatus });
    return;
  }

  /* An empty transcript is a real answer — silence, or a field recording — and the
     app says "nothing was heard" rather than inventing a sentence. */
  res.status(200).json({ text: transcript });
}
