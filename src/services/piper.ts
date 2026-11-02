/**
 * The Urdu voice the app carries.
 *
 * This exists because the device cannot be relied on for one. Measured on the
 * machine this was written on: Windows offers no Urdu speech pack at all — its
 * whole installable list stops at `pt-BR`, `zh-CN` and friends, with nothing
 * Indic or Pakistani — and iOS ships no Urdu voice either, so a phone that has
 * one is the exception rather than the rule. Without this file the app's answer
 * on such a device is to read Urdu script with an English voice, which is the
 * failure the Listen pills exist to avoid.
 *
 * So the voice is bundled instead: Piper's `ur_PK` model, phonemised by
 * espeak-ng and run by onnxruntime, all served from this app's own origin. No
 * key, no account, no request to anyone, and it works with the network off —
 * which is the only kind of speech worth having in a field with no signal.
 *
 * Everything here is loaded on first press and kept: the model is 63 MB and the
 * phonemiser's data is 18 MB, so a farmer who never presses Listen never pays
 * for either, and one who does pays once per session.
 *
 * The protocol is Piper's own, not invented here: text → phoneme ids →
 * `input`/`input_lengths`/`scales` into the voice → float PCM → WAV.
 */

type PiperConfig = {
  audio: { sample_rate: number };
  espeak: { voice: string };
  inference: { noise_scale: number; length_scale: number; noise_w: number };
  speaker_id_map: Record<string, number>;
};

type PhonemizerFactory = (options: {
  print: (data: string) => void;
  printErr: (message: string) => void;
  locateFile: (url: string) => string;
}) => Promise<{ callMain: (args: string[]) => void }>;

type PhonemizerWindow = Window & { createPiperPhonemize?: PhonemizerFactory };

/** Everything the voice needs, all under the app's own origin. */
const BASE = '/piper';
const VOICE = 'ur_PK-aegis_female-medium';
const MODEL_URL = `${BASE}/${VOICE}.onnx`;
const CONFIG_URL = `${BASE}/${VOICE}.onnx.json`;
const PIPER_WASM = `${BASE}/piper_phonemize.wasm`;
const PIPER_DATA = `${BASE}/piper_phonemize.data`;

/**
 * How much text one pass carries.
 *
 * Piper's own runtime uses 400; half that keeps the rhythm of a long sentence
 * steady and keeps the phonemiser's virtual file system small. The parts are
 * concatenated, so a split is inaudible apart from the pause it creates — which
 * lands on a sentence end, because that is where this splits.
 */
const CHUNK_CHARS = 200;

type PiperVoice = {
  ort: typeof import('onnxruntime-web');
  session: import('onnxruntime-web').InferenceSession;
  config: PiperConfig;
  phonemize: (text: string) => Promise<number[]>;
};

let voice: Promise<PiperVoice> | null = null;

/**
 * Brings the phonemiser in from this app's own origin.
 *
 * A `<script>` tag rather than an import, and not by preference: the published
 * package cannot be imported at all — its `main` is an absolute path
 * (`/build/piper_phonemize.js`), which resolves to `C:\build\…` and fails — and
 * the build has no ESM export either. It is a UMD file whose top-level `var`
 * becomes a global when it is loaded as a classic script, so that is how it is
 * loaded. The file itself is served from `public/piper`, alongside the espeak-ng
 * data and the `.wasm` this factory is told to find with `locateFile`.
 */
function loadPhonemizer(): Promise<PhonemizerFactory> {
  const target = window as PhonemizerWindow;
  if (target.createPiperPhonemize) return Promise.resolve(target.createPiperPhonemize);

  return new Promise<PhonemizerFactory>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${BASE}/piper_phonemize.js`;
    script.onload = () => {
      const factory = target.createPiperPhonemize;
      script.remove();
      if (factory) resolve(factory);
      else reject(new Error('The phonemiser did not register itself.'));
    };
    script.onerror = () => reject(new Error('The phonemiser could not be loaded.'));
    document.head.append(script);
  });
}

/**
 * Builds the voice once, and only when something actually asks to speak.
 *
 * Kept as a promise rather than a value so two presses in the same second share
 * one load — the model is 63 MB and racing two downloads of it is the one way
 * this design wastes a farmer's data.
 */
function load(): Promise<PiperVoice> {
  voice ??= (async () => {
    const [ort, factory, config] = await Promise.all([
      import('onnxruntime-web/wasm'),
      loadPhonemizer(),
      fetch(CONFIG_URL).then((response) => {
        if (!response.ok) throw new Error(`The voice configuration could not be read (${response.status}).`);
        return response.json() as Promise<PiperConfig>;
      }),
    ]);

    const runtime = ((ort as unknown as { default?: typeof import('onnxruntime-web') }).default ??
      ort) as typeof import('onnxruntime-web');

    /*
     * One thread, and the runtime's own bundled wasm.
     *
     * Threads would need `SharedArrayBuffer`, which needs cross-origin isolation
     * headers this app does not set — asking for them here would trade a working
     * voice on every device for a faster one on some.
     *
     * And `wasmPaths` is deliberately *not* set. Pointing it at a directory makes
     * the runtime fetch its wasm glue as a module at press time, and this app's
     * own server cannot serve that request: the bundler appends a marker to
     * runtime imports, which a file served straight off disk refuses — measured
     * as a 500 on `/piper/ort/ort-wasm-simd-threaded.mjs?import` and a warning of
     * "no available backend found". The build this imports has the runtime
     * inlined, so leaving the path alone is both simpler and the only version
     * that works.
     */
    if (runtime.env?.wasm) runtime.env.wasm.numThreads = 1;

    const modelResponse = await fetch(MODEL_URL);
    if (!modelResponse.ok) throw new Error(`The Urdu voice could not be read (${modelResponse.status}).`);
    const session = await runtime.InferenceSession.create(await modelResponse.arrayBuffer(), {
      executionProviders: ['wasm'],
    });

    /*
     * One phonemiser instance per sentence, which is how Piper's own runtime
     * does it: the Emscripten module runs `main` once and keeps its virtual file
     * system, so a second sentence on the same instance would be spoken as if it
     * followed the first — a pause in the text where the farmer wrote none.
     */
    const phonemize = async (text: string): Promise<number[]> => {
      const errors: string[] = [];

      const ids = await new Promise<number[]>((resolve, reject) => {
        let settled = false;
        const fail = (failure: unknown) => {
          if (settled) return;
          settled = true;
          reject(
            failure instanceof Error
              ? failure
              : new Error(errors.join(' ') || 'The words could not be phonemised.'),
          );
        };

        void factory({
          /* The phonemiser hands its answer back through `print`, as JSON. */
          print: (data: string) => {
            if (settled) return;
            try {
              const parsed = JSON.parse(data) as { phoneme_ids?: number[] };
              if (parsed.phoneme_ids) {
                settled = true;
                resolve(parsed.phoneme_ids);
              }
            } catch {
              /* Anything that is not the answer is noise on stdout. */
            }
          },
          /*
           * espeak-ng writes progress and word-level notes to stderr as a matter
           * of course, so these are kept for the error message rather than
           * treated as a failure — one stray line must not cost the farmer the
           * whole reading.
           */
          printErr: (message) => errors.push(message),
          locateFile: (url) =>
            url.endsWith('.wasm') ? PIPER_WASM : url.endsWith('.data') ? PIPER_DATA : url,
        })
          .then((instance) => {
            try {
              instance.callMain([
                '-l',
                config.espeak.voice,
                '--input',
                JSON.stringify([{ text }]),
                '--espeak_data',
                '/espeak-ng-data',
              ]);
            } catch (failure) {
              fail(failure);
            }
          })
          .catch(fail);
      });

      if (ids.length === 0) {
        throw new Error(errors.join(' ') || 'The words produced no audio.');
      }
      return ids;
    };

    return { ort: runtime, session, config, phonemize };
  })()
    /*
     * A failed load is not remembered.
     *
     * This is the bug that made the voice work "sometimes": the promise was kept
     * even when it rejected, so one bad first press — a model read that lost a
     * race with the dev server, a transient network stall on the 63 MB — left
     * every later press failing instantly and falling back to the platform's
     * English voice for the rest of the session. Forgetting the failure costs one
     * retry; remembering it costs the feature.
     */
    .catch((failure: unknown) => {
      voice = null;
      throw failure;
    });

  return voice;
}

/** Splits at sentence ends, so a part boundary is heard as a pause. */
/**
 * The parts the text is made in, in the order they are read: one sentence each.
 *
 * This is a latency decision, and it is measured rather than assumed. Making the
 * voice blocks this thread (onnxruntime in the page) and it runs at roughly three
 * quarters of real time on the machine this was written on: the weather advice is
 * 14 seconds of audio and takes about 18 seconds of model work. Packing several
 * sentences into one part therefore does not save the wait, it *hides* it as a
 * silence — and that is what a farmer heard. Every sentence is made on its own, so
 * a part is finished in about the time the part before it takes to listen to, and
 * the gaps land exactly on the sentence ends, where a pause is expected anyway.
 *
 * Two things follow that are worth knowing before changing this: a longer part is
 * not faster overall, only later; and the voice is genuinely slower than speech
 * here, which is why the fixes that matter are a smaller model or multi-threaded
 * wasm (`numThreads` in `load` is 1 — threads need cross-origin isolation).
 *
 * A single sentence longer than `limit` is still broken at a space, because a
 * voice that starts mid-word is the one artefact a listener cannot account for.
 */
export function splitForVoice(text: string, limit = CHUNK_CHARS): string[] {
  const sentences = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?۔؟])\s+/)
    .filter((sentence) => sentence.length > 0);

  const parts: string[] = [];
  for (const sentence of sentences) {
    let rest = sentence;
    while (rest.length > limit) {
      const space = rest.lastIndexOf(' ', limit);
      const cut = space > 0 ? space : limit;
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut).trim();
    }
    if (rest.length > 0) parts.push(rest);
  }

  return parts;
}

/** Float PCM to a 16-bit mono WAV, which every browser plays without a decoder. */
function encodeWav(pcm: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);

  const writeText = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };

  writeText(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, pcm.length * 2, true);

  for (let index = 0; index < pcm.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, pcm[index] ?? 0));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  return buffer;
}

/**
 * Sentences already made, by their own words.
 *
 * The voice is deterministic enough for this to be honest — Piper's noise scales
 * make each run slightly different, not different words — and it is the only way
 * to make a *repeat* press instant, because there is no smaller Urdu model to
 * switch to: the two published Urdu voices are both 60.6 MB medium models, so the
 * compute cannot be cut, only avoided.
 *
 * It earns its keep twice over. The weather advice is read again whenever the
 * farmer presses `Listen` a second time, and nothing is made the second time. And
 * a finger resting on the pill makes the first sentence before the press lands
 * (see `warmUrduVoice`), so the press starts from the first sound.
 */
const madeParts = new Map<string, Blob>();

/**
 * How many sentences are kept. A sentence is ~60 KB of 16-bit WAV, so this is
 * about 1.5 MB at worst — small next to the 63 MB model, and it only ever holds
 * advice this session has already heard.
 */
const MADE_PARTS_LIMIT = 24;

function rememberPart(words: string, audio: Blob): Blob {
  if (madeParts.size >= MADE_PARTS_LIMIT) {
    const oldest = madeParts.keys().next().value;
    if (oldest !== undefined) madeParts.delete(oldest);
  }
  madeParts.set(words, audio);
  return audio;
}

/** The WAV for one sentence: already in memory, or made and kept. */
async function partFor(loaded: PiperVoice, words: string): Promise<Blob> {
  const ready = madeParts.get(words);
  if (ready) return ready;
  return rememberPart(words, await makePart(loaded, words));
}

/** Runs the model for one sentence. This is the expensive, thread-blocking part. */
async function makePart(loaded: PiperVoice, words: string): Promise<Blob> {
  const { ort, session, config, phonemize } = loaded;
  const ids = await phonemize(words);
  const hasSpeakers = Object.keys(config.speaker_id_map ?? {}).length > 0;

  const feeds: Record<string, import('onnxruntime-web').Tensor> = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
    /* One batch, one length: the shape is `[1]`, and the *value* is how many
       phonemes there are. Declaring the length as the dimension instead — as
       Piper's own wrapper does — makes the runtime reject the tensor. */
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor(
      'float32',
      Float32Array.from([
        config.inference.noise_scale,
        config.inference.length_scale,
        config.inference.noise_w,
      ]),
    ),
  };
  if (hasSpeakers) {
    feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
  }

  const output = await session.run(feeds);
  const pcm = output.output?.data;
  if (!(pcm instanceof Float32Array)) throw new Error('The voice returned no audio.');

  return new Blob([encodeWav(pcm, config.audio.sample_rate)], { type: 'audio/wav' });
}

/**
 * Reads text aloud as WAV parts, entirely on this device.
 *
 * Returns false when the voice cannot run — no WASM, no storage, a model that
 * cannot be read. The cause is logged, and *not remembered*: the failed load is
 * dropped so the next press tries again rather than failing instantly for the
 * rest of the session. False means nothing was said, and callers treat it as
 * such — Urdu is never handed to a voice that does not speak it.
 *
 * `onPart` is given each sentence the moment it exists, not at the end: speech
 * starts while the rest of the passage is still being made. This is the
 * difference between a pill that answers and a pill that sits there — see
 * `splitForVoice` — and a sentence already in `madeParts` arrives with no model
 * work at all.
 */
export async function synthesiseUrduSpeech(
  text: string,
  onPart: (audio: Blob) => void,
): Promise<boolean> {
  try {
    const loaded = await load();
    const parts = splitForVoice(text);
    if (parts.length === 0) return false;

    for (const part of parts) {
      onPart(await partFor(loaded, part));
    }

    return true;
  } catch (failure) {
    /*
     * Told, not dropped: a voice that stops working is otherwise
     * indistinguishable from a device that never had one, and the difference is
     * the whole reason this file exists. The message is the only thing standing
     * between "the press did nothing" and a five-minute hunt.
     */
    console.warn('[speech] the Urdu voice could not run:', failure);
    return false;
  }
}

/**
 * Starts getting the voice ready without saying anything.
 *
 * Two things are done here, and both exist because the model cannot be swapped
 * for a faster one — Piper publishes no Urdu voice smaller than the 60.6 MB
 * medium (checked: `aegis_female` and `fasih` are the only two, both medium, both
 * 60.6 MB):
 *
 * · the 63 MB model and 18 MB phonemiser start arriving (the press would
 *   otherwise begin with that download);
 * · the *first sentence* is made and kept, so the press starts at the first
 *   sound instead of waiting for the model to run. This is the one that answers
 *   a press in a few hundred milliseconds rather than a few seconds.
 *
 * Called from the `Listen` pill's hover and focus (`SpeechProvider.warm`): a
 * finger rests there and a keyboard lands there before either presses it. Nothing
 * is said — `onPart` is not called and no audio is played.
 *
 * A failure is deliberately silent: nothing was asked for yet, and the press that
 * follows reports the cause itself. It is also not remembered — in `load`, a
 * rejected attempt is dropped.
 */
export function warmUrduVoice(text?: string): void {
  void (async () => {
    const loaded = await load();
    const first = text ? splitForVoice(text)[0] : undefined;
    if (first) await partFor(loaded, first);
  })().catch(() => undefined);
}
