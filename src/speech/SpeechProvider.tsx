import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  pickVoice,
  speakText,
  speakWithAppVoice,
  speechSupported,
  stopSpeaking,
  warmAppVoice,
} from '@/services/speech';

/**
 * Who is talking, and whether this device can.
 *
 * Read-aloud is a capability of the *device*, not a service, so it lives above
 * the screens rather than inside one: the weather card and the scan verdict read
 * advice aloud in the same voice, and leaving one screen has to be able to stop
 * what the other started. Holding it in a provider is also what makes one voice
 * at a time structural — there is a single `speaking` id, so two pills cannot
 * both believe they are the one playing.
 *
 * The one subtlety is that a device's voice list is delivered *late*: the first
 * read is usually empty and the real list arrives on `voiceschanged`. Reporting
 * "this language cannot be read" before that arrives would grey out a control
 * that works, so an empty list is `unknown`, not `absent`.
 *
 * Speaking never refuses for want of a matching voice, and takes the best voice
 * available in this order: the device's own voice for the language, then the
 * Urdu voice the app carries (Piper, on-device — `services/piper.ts`).
 *
 * There is deliberately no third step, and that is a fix rather than an
 * omission. The platform's default used to be the last resort so that a pressed
 * speaker always answered — and on this machine that is exactly what was heard:
 * three en-US voices reading Urdu script aloud in English, sentence after
 * sentence. A farmer who hears English advice cannot tell a mispronounced word
 * from a wrong one, and the control answers with the very failure the feature
 * exists to prevent. So Urdu is read by an Urdu voice or not at all: if the
 * carried voice cannot load, the press is silent, the console says why, and the
 * next press retries (a failed load is not remembered).
 */

export type SpeechValue = {
  /** False when the platform has no speech at all — no voice can change that. */
  supported: boolean;
  /** The id passed to `speak` for whatever is being read, or null. */
  speaking: string | null;
  /** Returns false only when the platform has no speech at all. */
  speak: (input: { id: string; text: string; lang: string }) => boolean;
  /**
   * Starts getting the voice this language will be read in ready, without
   * speaking. `text` is what the pill would read.
   *
   * Called when a finger or a keyboard is already on the pill, so the press is
   * not the moment the 63 MB model starts arriving — nor the moment the first
   * sentence has to be made, because warming makes that one too. A language the
   * device has its own voice for is not warmed: there is nothing to fetch.
   */
  warm: (lang: string, text: string) => void;
  stop: () => void;
};

const SpeechContext = createContext<SpeechValue | null>(null);

export function SpeechProvider({ children }: { children: ReactNode }) {
  const supported = speechSupported();
  const [voices, setVoices] = useState<readonly SpeechSynthesisVoice[]>(() =>
    supported ? window.speechSynthesis.getVoices() : [],
  );
  const [speaking, setSpeaking] = useState<string | null>(null);

  useEffect(() => {
    if (!supported) return;
    const synth = window.speechSynthesis;
    const sync = () => setVoices(synth.getVoices());

    sync();
    synth.addEventListener('voiceschanged', sync);
    return () => {
      synth.removeEventListener('voiceschanged', sync);
      /* The app is going away; a phone that keeps reading advice from a closed
         tab is the failure this line exists for. */
      synth.cancel();
    };
  }, [supported]);

  const stop = useCallback(() => {
    setSpeaking(null);
    stopSpeaking();
  }, []);

  const warm = useCallback(
    (lang: string, text: string) => {
      /* The device's own voice needs no warming — it answers the moment it is
         asked. Only the carried voice has a cost to pay before the first word. */
      if (!text || pickVoice(voices, lang)) return;
      warmAppVoice(text);
    },
    [voices],
  );

  const speak = useCallback<SpeechValue['speak']>(
    ({ id, text, lang }) => {
      const onEnd = () => setSpeaking((current) => (current === id ? null : current));
      const voice = pickVoice(voices, lang);

      if (voice) {
        const started = speakText(text, { lang, voice, onEnd });
        setSpeaking(started ? id : null);
        return started;
      }

      if (!supported && typeof window === 'undefined') return false;

      /*
       * No voice for this language on this device, so the app's own Urdu voice
       * reads it. The pill holds its speaking state while the 63 MB loads on the
       * first press. Nothing else may read these words: a platform default that
       * has no Urdu says them in English, and English advice is worse than no
       * advice, because the farmer cannot hear that it is wrong.
       */
      setSpeaking(id);
      void speakWithAppVoice(text, onEnd)
        .then((spokenByApp) => {
          if (!spokenByApp) setSpeaking((current) => (current === id ? null : current));
        })
        .catch((failure: unknown) => {
          /* The voice is missing and nothing was read. The next press tries
             again — `services/piper.ts` drops the failed load on purpose. */
          console.warn('[speech] the app voice could not be used:', failure);
          setSpeaking((current) => (current === id ? null : current));
        });
      return true;
    },
    [supported, voices],
  );

  const value = useMemo<SpeechValue>(
    () => ({ supported, speaking, speak, warm, stop }),
    [supported, speaking, speak, warm, stop],
  );

  return <SpeechContext.Provider value={value}>{children}</SpeechContext.Provider>;
}

export function useSpeech(): SpeechValue {
  const context = useContext(SpeechContext);
  if (!context) {
    throw new Error('useSpeech must be used inside a SpeechProvider');
  }
  return context;
}
