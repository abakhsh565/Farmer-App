/**
 * The microphone, recorded and transcribed.
 *
 * This replaces the browser's speech recogniser as the way a farmer talks to the
 * app, and the reason is measured rather than theoretical: in this app's own
 * preview, `webkitSpeechRecognition` exists in the packaged Chromium, `start()`
 * succeeds, the control shows "Listening…" — and no transcript ever arrives,
 * because that constructor on desktop has no speech service behind it. A mic that
 * looks alive and never answers is the worst of the three possible states.
 *
 * Recording has none of that: `getUserMedia` + `MediaRecorder` are in every
 * Chromium and every WebView the app ships in, and the words are produced by our
 * own endpoint (`/api/transcribe`), which asks for Urdu script explicitly. It also
 * costs nothing until the farmer presses, and it never keeps the microphone open
 * after the sentence.
 *
 * The contract is one utterance, like the recogniser it replaces: press to start,
 * press to stop, or let the twelve-second cap stop it. Continuous listening is not
 * offered — a microphone that keeps recording is a microphone that records the
 * field, and the farmer's battery.
 *
 * Failures are three, and the screen says which: the microphone was refused, the
 * recording was silent, or the transcription could not be reached. "Something went
 * wrong" is not an answer a farmer can act on.
 */

export type MicrophoneFailure = 'denied' | 'empty' | 'unavailable';

export type Recording = {
  /** Stops early: the farmer pressed again, or left the screen. */
  stop: () => void;
};

export type StartRecording = {
  onText: (said: string) => void;
  onFailure: (reason: MicrophoneFailure) => void;
  /** Always called, after the words or the failure — the button's listening state. */
  onEnd: () => void;
  /** Longest one utterance may run. */
  limitMs?: number;
};

/** Where the transcription lives. Overridable, so a deployment can host it elsewhere. */
const ENDPOINT = ((import.meta.env.VITE_TRANSCRIBE_ENDPOINT as string | undefined) ?? '/api/transcribe').trim();

/** Containers in the order browsers accept them. Opus in WebM is what Chrome writes. */
const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];

/** Twelve seconds: long enough for a question about a crop, short enough to be one. */
const LIMIT_MS = 12_000;

/** Below this a recording is a tap on the phone, not speech. */
const MIN_BYTES = 900;

/** Whether this device can record at all, so the control is only drawn when it can. */
export function recordingSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof window !== 'undefined' &&
    typeof window.MediaRecorder !== 'undefined'
  );
}

function mimeTypeFor(): string | undefined {
  return MIME_TYPES.find((type) => window.MediaRecorder.isTypeSupported?.(type));
}

/** Base64 through a FileReader: `btoa` on a large array is a stack overflow. */
function asBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The recording could not be read.'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      /* A data URL is `data:audio/webm;base64,<payload>`. */
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

async function transcribe(blob: Blob): Promise<string> {
  const audio = await asBase64(blob);
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio, mimeType: blob.type || 'audio/webm', language: 'ur-PK' }),
  });

  if (!response.ok) throw new Error(`The transcription endpoint answered ${response.status}.`);

  const payload = (await response.json().catch(() => null)) as { text?: unknown } | null;
  return typeof payload?.text === 'string' ? payload.text.trim() : '';
}

/**
 * Starts one recording.
 *
 * Returns `null` when the device cannot record or the microphone was refused; in
 * both cases `onEnd` has already been called, so a button that shows "listening"
 * cannot be left on.
 */
export function startRecording({
  onText,
  onFailure,
  onEnd,
  limitMs = LIMIT_MS,
}: StartRecording): Recording | null {
  if (!recordingSupported()) {
    onFailure('unavailable');
    onEnd();
    return null;
  }

  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let timer: number | null = null;
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    if (timer !== null) window.clearTimeout(timer);
    stream?.getTracks().forEach((track) => track.stop());
    onEnd();
  };

  const stop = () => {
    if (finished) return;
    try {
      recorder?.stop();
    } catch {
      finish();
    }
  };

  void navigator.mediaDevices
    .getUserMedia({ audio: true })
    .then((granted) => {
      stream = granted;
      const type = mimeTypeFor();
      recorder = new MediaRecorder(granted, type ? { mimeType: type } : undefined);
      const chunks: Blob[] = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' });
        if (blob.size < MIN_BYTES) {
          onFailure('empty');
          finish();
          return;
        }

        void transcribe(blob)
          .then((said) => {
            if (said.length > 0) onText(said);
            else onFailure('empty');
          })
          .catch(() => onFailure('unavailable'))
          .finally(finish);
      };

      recorder.start();
      timer = window.setTimeout(stop, limitMs);
    })
    .catch((failure: unknown) => {
      /* A refused microphone and a missing device are different sentences for the
         farmer: one is a setting to allow, the other is a phone that cannot. */
      const denied = failure instanceof DOMException && failure.name === 'NotAllowedError';
      onFailure(denied ? 'denied' : 'unavailable');
      finish();
    });

  return { stop };
}
