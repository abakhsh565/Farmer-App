/**
 * The device's own voice.
 *
 * The weather card and the scan verdict each carry a `Listen` pill, and spoken
 * advice is the whole point of them: the sentence under that pill — when to
 * spray, what is wrong with the plant — is the one a farmer acts on in a field,
 * and often without reading it comfortably. This module is the piece the app was
 * missing, and it is deliberately thin: it wraps the platform's speech synthesis
 * and nothing else, so reading a sentence that is already on screen costs no
 * provider, no key and no network.
 *
 * Three decisions are the module rather than plumbing:
 *
 * · **One voice, matched to the language, and never a different language.** A
 *   voice is chosen for the farmer's own tag — `ur-PK` first, any `ur` voice
 *   after that. Where the device has no voice for the language the app's own
 *   Urdu voice reads it, and there is no third step: the platform's default made
 *   the pill always answer, and on a device with no Urdu it answered in English.
 *   Urdu is read by an Urdu voice or not at all.
 *
 * · **The text arrives whole; the platform gets it in parts.** Engines drop long
 *   utterances mid-sentence, so the words are split at sentence ends and queued.
 *   Splitting on punctuation rather than on a character count is what keeps
 *   "Finish before noon." from being heard as two half-sentences.
 *
 * · **The voice is not the app's to leave running.** Every part queues into one
 *   engine, so a second press replaces the first instead of talking over it, and
 *   `stopSpeaking` exists for the screen to call when it goes away.
 *
 * · **When the device has no voice for the language, the app fetches it.** This
 *   is the case that matters most, because it is the common one: Windows ships no
 *   Urdu speech pack at all (its own capability list offers no Indic or Pakistani
 *   language), iOS ships none, and Android only sometimes. Measured on this
 *   machine, a device with three en-US voices reads an Urdu sentence with an
 *   English voice — the farmer hears English, which is the exact failure this
 *   file exists to prevent. So the Urdu audio is requested and played through an
 *   `<audio>` element instead, which needs no key and is not blocked the way a
 *   cross-origin `fetch` would be.
 *
 *   A keyless web endpoint was tried for this and does not work from a page, and
 *   the file records it so the next person does not spend the same hour on it:
 *   that endpoint answers a bare request with `audio/mpeg`, but with a browser's
 *   own headers it answers **404 `text/html`**, which Chrome then refuses as
 *   `ERR_BLOCKED_BY_ORB` — verified in this app's own network log.
 *
 *   The offline answer — an Urdu model running on the device — was investigated
 *   and is real but not finished, and this records exactly where it stops: Piper
 *   does publish an Urdu voice (`rhasspy/piper-voices` → `ur/ur_PK` →
 *   `ur_PK-aegis_female-medium`, 63 MB), and a browser runtime for it exists. The
 *   ready-made package is `@mintplex-labs/piper-tts-web`, but it can only fetch
 *   voices from a fixed mirror, and **that mirror contains no Urdu at all**
 *   (`"ur does not exist on main"`), so pointing it at `ur_PK-…` asks for
 *   `…/main/undefined.json` and gets a 404 — measured in this app's own network
 *   log. Finishing it therefore means running `@diffusionstudio/piper-wasm`
 *   directly against a model we host ourselves, which is a day's work and a 63 MB
 *   asset, not a configuration change.
 *
 * The speech recogniser is *not* here: `ScanScreen` owns that, because it is a
 * control on a screen rather than a capability of the app.
 */

/** What one utterance may carry before engines start dropping its tail. */
const CHUNK_CHARS = 180;



/**
 * A shade under normal speed.
 *
 * Advice is the one thing on these screens a farmer may write down or repeat to
 * someone, and the platforms' default rate is tuned for a screen reader used by
 * someone following along with their eyes.
 */
const RATE = 0.95;

/**
 * The speech engine, read through a check rather than assumed.
 *
 * `jsdom` has neither, and neither do locked-down browsers, so the capability is
 * probed once here and every caller above can stay free of `try`/`catch`.
 */
function engine(): { synth: SpeechSynthesis; Utterance: typeof SpeechSynthesisUtterance } | null {
  if (typeof window === 'undefined') return null;
  if (typeof window.speechSynthesis === 'undefined') return null;
  if (typeof window.SpeechSynthesisUtterance === 'undefined') return null;
  return { synth: window.speechSynthesis, Utterance: window.SpeechSynthesisUtterance };
}

/** False when this device cannot speak at all, whatever the language. */
export function speechSupported(): boolean {
  return engine() !== null;
}

/** The language part of a BCP 47 tag: `ur-PK` → `ur`. */
export function baseLanguage(tag: string): string {
  return tag.split('-')[0]?.toLowerCase() ?? '';
}

/**
 * The voice that should read this language, or `undefined` when the device has
 * none. An exact tag wins over the same language in another region — `ur-PK`
 * over `ur-IN` — because the two differ in the words the voice gets right.
 */
export function pickVoice(
  voices: readonly SpeechSynthesisVoice[],
  tag: string,
): SpeechSynthesisVoice | undefined {
  const wanted = tag.toLowerCase();
  const base = baseLanguage(tag);
  return (
    voices.find((voice) => voice.lang.toLowerCase() === wanted) ??
    voices.find((voice) => baseLanguage(voice.lang) === base)
  );
}

/**
 * The text in parts the platform can finish.
 *
 * Sentences are packed up to the limit and never split across parts, except when
 * a single sentence is longer than the limit — where it is broken on a space,
 * because a voice that starts mid-word is the one artefact a listener cannot
 * account for.
 */
export function splitForSpeech(text: string, limit = CHUNK_CHARS): string[] {
  const sentences = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?۔؟])\s+/)
    .filter((sentence) => sentence.length > 0);

  const parts: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if (current.length === 0) current = sentence;
    else if (current.length + sentence.length + 1 <= limit) current = `${current} ${sentence}`;
    else {
      parts.push(current);
      current = sentence;
    }

    while (current.length > limit) {
      const space = current.lastIndexOf(' ', limit);
      const cut = space > 0 ? space : limit;
      parts.push(current.slice(0, cut));
      current = current.slice(cut).trim();
    }
  }

  if (current.length > 0) parts.push(current);
  return parts;
}

/*
 * There is no `spokenVoice` any more, and its absence is the fix.
 *
 * It used to return the platform's default when the device had no voice for the
 * language, so that a pressed speaker always answered. Measured on this machine,
 * that answered in English — three en-US voices reading Urdu script — which a
 * farmer cannot tell apart from wrong advice. A voice for another language is
 * not a substitute for a missing one; the app's own Urdu voice
 * (`services/piper.ts`) is, and when it cannot run the right answer is silence.
 */

export type SpeakOptions = {
  /** BCP 47 tag, e.g. `ur-PK`. */
  lang: string;
  /** Omitted when the device has not delivered a voice list; the engine decides. */
  voice?: SpeechSynthesisVoice;
  /** Fired when the first part actually begins — not when it was queued. */
  onStart?: () => void;
  /** Fired when the last part ends, or when the engine refuses a part. */
  onEnd?: () => void;
};

/* --------------------------------------------------------------------------
   The voice the app carries — Piper's Urdu model, run on this device.
   -------------------------------------------------------------------------- */

let voicePlayer: HTMLAudioElement | null = null;
/** Bumped by every stop, so a model still waking up cannot start talking later. */
let voiceToken = 0;
/** Object URLs handed to the element and not yet freed — one per part unplayed. */
let voiceUrls: string[] = [];

function freeVoiceUrl(url: string): void {
  voiceUrls = voiceUrls.filter((pending) => pending !== url);
  URL.revokeObjectURL(url);
}

/** Drops everything waiting to be played. Called by a stop, and by a new press. */
function freeVoiceUrls(): void {
  for (const url of voiceUrls) URL.revokeObjectURL(url);
  voiceUrls = [];
}

/**
 * Reads the text with the app's own Urdu voice, part by part.
 *
 * Resolves true once the first part is playing, false when nothing was made at
 * all. The caller does *not* hand Urdu to another voice when that happens — it
 * says nothing and lets the next press bring the model up — so a `false` here
 * means `piper.ts` has already logged the real cause.
 *
 * **Why one part at a time.** The model runs on this thread, and it used to make
 * the whole passage before handing over a single WAV: 13 seconds of audio for the
 * weather advice, and the farmer heard none of it until the last sentence was
 * built. Now the first sentence plays while the rest is being made, which is what
 * makes a press feel answered — the wait is one sentence, not one passage. The
 * parts are handed over in reading order and played back to back, and each break
 * lands on a sentence end, so the joins are heard as pauses rather than seams.
 *
 * The first call of a page load also pays for 63 MB of model and 18 MB of
 * phonemiser; `piper.ts` keeps them afterwards, forgets a failed attempt, and
 * offers a warm-up for a finger that is already on the pill.
 */
export async function speakWithAppVoice(text: string, onEnd?: () => void): Promise<boolean> {
  if (typeof window === 'undefined' || typeof window.Audio === 'undefined') return false;
  const token = ++voiceToken;

  const { synthesiseUrduSpeech } = await import('./piper');
  const element = (voicePlayer ??= new window.Audio());

  /* One voice at a time: a newer press replaces the part still being heard. */
  element.onended = null;
  element.onerror = null;
  element.pause();
  freeVoiceUrls();

  const queue: string[] = [];
  let synthesisFinished = false;
  let busy = false;
  let handed = 0;
  let answered = false;
  let settle: (started: boolean) => void = () => undefined;
  const started = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  const answer = (value: boolean) => {
    if (answered) return;
    answered = true;
    settle(value);
  };

  /** Hands the next part to the element, or finishes when there is none left. */
  const pump = () => {
    /* Stopped, or replaced by a newer press: the queue is not ours any more. */
    if (token !== voiceToken || busy) return;

    const url = queue.shift();
    if (!url) {
      if (synthesisFinished) onEnd?.();
      return;
    }

    busy = true;
    const done = () => {
      busy = false;
      freeVoiceUrl(url);
      pump();
    };
    element.onended = done;
    /* A part that will not play is skipped rather than left as a silence in the
       middle of the advice; the reading only stops if the last part fails. */
    element.onerror = done;
    element.src = url;
    void element.play().then(
      () => answer(true),
      done,
    );
  };

  const spoken = await synthesiseUrduSpeech(text, (audio) => {
    /* The farmer stopped, or pressed again, while this part was being made. */
    if (token !== voiceToken) return;
    const url = URL.createObjectURL(audio);
    voiceUrls.push(url);
    queue.push(url);
    handed += 1;
    pump();
  });

  synthesisFinished = true;
  if (token !== voiceToken) {
    /* A newer press owns the voice now, and it must not have its state cleared. */
    answer(true);
  } else if (!spoken && handed === 0) {
    answer(false);
  }
  pump();

  return started;
}

/**
 * Starts getting the app's Urdu voice ready without pressing anything: the model
 * arrives, and the sentence the farmer is about to hear is made in advance.
 *
 * `text` is the advice the pill would read, which is known before it is pressed.
 * Wired to the `Listen` pill's hover and focus — see `SpeechProvider.warm`.
 */
export function warmAppVoice(text: string): void {
  void import('./piper')
    .then((piper) => piper.warmUrduVoice(text))
    .catch(() => undefined);
}

/**
 * Reads the text aloud. Returns false when it could not be started at all, which
 * is the caller's cue that the control has nothing to do.
 */
export function speakText(text: string, { lang, voice, onStart, onEnd }: SpeakOptions): boolean {
  const target = engine();
  if (!target) return false;

  const parts = splitForSpeech(text);
  if (parts.length === 0) return false;

  /* One voice at a time: a second press replaces the first rather than layering
     two readings of the same advice. */
  target.synth.cancel();

  parts.forEach((part, index) => {
    const utterance = new target.Utterance(part);
    utterance.lang = lang;
    if (voice) utterance.voice = voice;
    utterance.rate = RATE;

    if (index === 0 && onStart) utterance.onstart = () => onStart();
    if (index === parts.length - 1) {
      utterance.onend = () => onEnd?.();
      /* `onerror` is the only signal a refused voice gives, and without it the
         pill would stay stuck in its speaking state for ever. */
      utterance.onerror = () => onEnd?.();
    }

    target.synth.speak(utterance);
  });

  return true;
}

/** Everything queued or in progress stops. Safe to call when nothing is speaking. */
export function stopSpeaking(): void {
  engine()?.synth.cancel();

  /* Bumping the token is what stops the queue: a part still being made is
     dropped, and the pump refuses to hand over the next one. */
  voiceToken += 1;
  if (voicePlayer) {
    voicePlayer.onended = null;
    voicePlayer.onerror = null;
    voicePlayer.pause();
  }
  freeVoiceUrls();
}
