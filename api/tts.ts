/**
 * The Urdu voice endpoint.
 *
 * A serverless function, not client code, because the credential cannot be in the
 * app: anything the browser can read is inlined into the JavaScript and shipped
 * inside the APK. `GEMINI_API_KEY` lives here, in the deployment's environment,
 * and never reaches a device. This replaces the 79 MB on-device model the app
 * used to carry, which is what makes an APK and an OTA update small.
 *
 * The request is the same one Google documents for Gemini TTS: `generateContent`
 * with the AUDIO response modality and an explicit `ur-PK` speech config. Gemini
 * answers with raw PCM (24 kHz, 16-bit, mono) in base64, so the header is added
 * here — an `<audio>` element cannot play headerless PCM.
 *
 * Refusals are machine codes, not prose, so the app can say the one true thing:
 *
 *   503 voice-not-configured   the deployment has no GEMINI_API_KEY yet
 *   502 voice-upstream-failed  the provider answered, but not with audio
 *   429 voice-busy             the provider's free-tier rate limit was hit
 *   405 method-not-allowed     anything but POST
 *
 * Nothing here logs the text it was given or the key it used.
 */

type RequestBody = {
  text?: unknown;
  language?: unknown;
};

/**
 * The models this endpoint may speak with, best first.
 *
 * One model is not enough, and that is measured rather than defensive: Gemini's
 * TTS models carry *separate* free-tier quotas, and on 2026-11-23 the configured
 * `gemini-3.8-flash-tts` answered `429` while `gemini-3.8-flash-lite-tts`
 * answered `200` with real Urdu audio on the very same key. A farmer pressing
 * Listen must not be told the voice is broken because the preferred model's
 * minute is spent, so the next model is tried, and the next.
 *
 * `GEMINI_TTS_MODEL` still wins, so a deployment can pin one model and keep the
 * rest as fallbacks. Duplicates and blanks are dropped.
 */
const MODELS = [
  process.env.GEMINI_TTS_MODEL ?? 'gemini-3.8-flash-tts',
  'gemini-3.8-flash-lite-tts',
  'gemini-3.1-flash-tts-preview',
  'gemini-2.5-flash-preview-tts',
].filter((model, index, all) => model.length > 0 && all.indexOf(model) === index);

const VOICE = process.env.GEMINI_TTS_VOICE ?? 'Kore';
const LANGUAGE = 'ur-PK';

/**
 * What is spoken is Urdu, even when what was written is not.
 *
 * The app answers in the language the farmer chose for the interface, and a
 * farmer who reads English still listens in Urdu — that is the whole point of the
 * pill. A TTS model asked for `ur-PK` will read an English sentence as English
 * words in an Urdu mouth, which is not the same thing, so text that carries no
 * Urdu script is translated first and the *translation* is spoken.
 *
 * `gemini-2.5-flash` is enough for one sentence and is in this account's own model
 * list. A translation that fails is not fatal: the original is spoken, which is
 * worse to listen to but still true advice, and silence is neither.
 */
const URDU_SCRIPT = /[\u0600-\u06FF]/;
const TEXT_MODEL = process.env.GEMINI_TRANSLATE_MODEL ?? 'gemini-2.5-flash';

async function toUrdu(key: string, text: string): Promise<string> {
  if (URDU_SCRIPT.test(text)) return text;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(TEXT_MODEL)}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: [
                  'Translate the following into natural spoken Urdu.',
                  'Keep names, numbers and units as they are.',
                  'Reply with the Urdu sentence only — no English, no notes.',
                  '',
                  text,
                ].join('\n'),
              },
            ],
          },
        ],
        generationConfig: { temperature: 0 },
      }),
    },
  ).catch(() => null);

  if (!response?.ok) return text;

  const payload = (await response.json().catch(() => null)) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  } | null;

  const said = (payload?.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part?.text ?? '')
    .join(' ')
    .trim();

  return said.length > 0 ? said : text;
}

/** Gemini TTS returns 24 kHz, 16-bit, mono PCM. */
const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BITS = 16;

/** Longest text one request accepts. The app splits well before this. */
const MAX_CHARS = 900;

function wav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = (SAMPLE_RATE * CHANNELS * BITS) / 8;
  const blockAlign = (CHANNELS * BITS) / 8;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

export type HandlerRequest = {
  method?: string;
  body?: unknown;
};

export type HandlerResponse = {
  status: (code: number) => HandlerResponse;
  setHeader: (name: string, value: string) => void;
  json: (body: unknown) => void;
  send: (body: Buffer) => void;
  end: (body?: string) => void;
};

function readBody(body: unknown): RequestBody {
  if (typeof body === 'string') {
    try {
      return JSON.parse(body) as RequestBody;
    } catch {
      return {};
    }
  }
  if (body && typeof body === 'object') return body as RequestBody;
  return {};
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
    /*
     * Deliberately 503 and not an empty 200: an app that cannot speak must be
     * able to tell the difference between "no key configured" and "the model has
     * nothing to say", and the farmer is never shown a broken player.
     */
    res.status(503).json({ error: 'voice-not-configured' });
    return;
  }

  const { text, language } = readBody(req.body);
  const spoken = typeof text === 'string' ? text.trim() : '';

  if (!spoken || spoken.length > MAX_CHARS) {
    res.status(400).json({ error: 'text-required', maxChars: MAX_CHARS });
    return;
  }

  // Urdu only: this endpoint exists to read one language, and a request for
  // another is a bug in the caller rather than a feature.
  const wanted = typeof language === 'string' ? language.toLowerCase() : LANGUAGE.toLowerCase();
  if (!wanted.startsWith('ur')) {
    res.status(400).json({ error: 'unsupported-language' });
    return;
  }

  const spokenInUrdu = await toUrdu(key, spoken);

  const request = JSON.stringify({
    contents: [{ parts: [{ text: spokenInUrdu }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        languageCode: LANGUAGE,
        voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } },
      },
    },
  });

  /** Which model answered, or why none could. Never sent to the client. */
  let inline: { data?: string; mimeType?: string } | null = null;
  let exhausted = 0;
  let lastStatus: number | string | null = null;

  for (const model of MODELS) {
    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': key,
        },
        body: request,
      },
    ).catch(() => null);

    if (!upstream) {
      lastStatus = 'unreachable';
      continue;
    }

    /*
     * A spent quota is the one answer that is worth trying another model for,
     * because the quotas are per model. Any other refusal is the provider saying
     * no to this request, and the next model would say the same thing.
     */
    if (upstream.status === 429) {
      exhausted += 1;
      continue;
    }

    if (!upstream.ok) {
      // The provider's own code, never its body: an error body can echo the input.
      lastStatus = upstream.status;
      continue;
    }

    const payload = (await upstream.json().catch(() => null)) as {
      candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[];
    } | null;

    const found = payload?.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data)
      ?.inlineData;

    if (!found?.data) {
      lastStatus = 'no-audio';
      continue;
    }

    inline = found;
    break;
  }

  if (!inline?.data) {
    /* Every model answered "quota spent", which is the farmer's cue to try in a
       minute rather than a fault to report. */
    if (exhausted > 0 && exhausted === MODELS.length) {
      res.status(429).json({ error: 'voice-busy' });
      return;
    }
    res.status(502).json({ error: 'voice-upstream-failed', reason: lastStatus });
    return;
  }

  const audio = Buffer.from(inline.data, 'base64');
  // Some responses already carry a WAV container; wrapping it again would make a
  // file no player opens.
  const body = inline.mimeType?.includes('wav') ? audio : wav(audio);

  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Content-Length', String(body.length));
  res.status(200).send(body);
}
