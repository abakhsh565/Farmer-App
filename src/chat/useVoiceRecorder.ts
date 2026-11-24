import { useCallback, useEffect, useRef, useState } from 'react';
import { VOICE_LIMITS, chooseVoiceMimeType } from '@/shop/api/voice';

/**
 * The microphone, for a voice message rather than a transcript.
 *
 * Three states and no fourth: `idle`, `recording`, `preview`. Preview is the part
 * WhatsApp taught everyone to expect — the recording exists, it can be played back
 * and thrown away, and nothing reaches the shop until the farmer presses send. A
 * recorder that uploads on stop gets cancelled messages into someone's inbox.
 *
 * The blob is held in memory only. A recording that is cancelled is gone: keeping it
 * in storage would mean a cancelled voice note could be recovered from the phone,
 * which is the opposite of what cancel means.
 *
 * Auto-stop at the cap is deliberate rather than an error: an open microphone on a
 * phone in a pocket must not run until the battery or the quota gives out. The
 * caller sees a complete preview, exactly as if the farmer had stopped it.
 */

export type RecorderStatus = 'idle' | 'recording' | 'preview';

export type RecorderFailure = 'denied' | 'unavailable' | 'empty';

export type PendingRecording = {
  blob: Blob;
  mimeType: string;
  durationMs: number;
};

export function useVoiceRecorder({ maxDurationMs = VOICE_LIMITS.maxDurationMs } = {}) {
  const [status, setStatus] = useState<RecorderStatus>('idle');
  const [durationMs, setDurationMs] = useState(0);
  const [failure, setFailure] = useState<RecorderFailure | null>(null);
  const [recording, setRecording] = useState<PendingRecording | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const tickRef = useRef<number | null>(null);
  const stopTimerRef = useRef<number | null>(null);
  const discardRef = useRef(false);

  /** Releases the microphone and every timer. Called from every exit path. */
  const teardown = useCallback(() => {
    if (tickRef.current !== null) window.clearInterval(tickRef.current);
    if (stopTimerRef.current !== null) window.clearTimeout(stopTimerRef.current);
    tickRef.current = null;
    stopTimerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  useEffect(() => teardown, [teardown]);

  const start = useCallback(async () => {
    setFailure(null);

    if (
      typeof navigator === 'undefined' ||
      typeof navigator.mediaDevices?.getUserMedia !== 'function' ||
      typeof window === 'undefined' ||
      typeof window.MediaRecorder === 'undefined'
    ) {
      setFailure('unavailable');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      discardRef.current = false;
      chunksRef.current = [];

      const mimeType = chooseVoiceMimeType();

      /* 32 kbps mono is speech: 60 s stays under 250 kB, which is one bar of signal
         on 2G rather than a minute of silence. */
      const recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 32_000,
      });
      recorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.onstop = () => {
        const elapsed = Math.min(maxDurationMs, Date.now() - startedAtRef.current);
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || mimeType || 'audio/webm',
        });
        teardown();

        if (discardRef.current || blob.size < VOICE_LIMITS.minBytes) {
          setStatus('idle');
          setRecording(null);
          setDurationMs(0);
          if (!discardRef.current) setFailure('empty');
          return;
        }

        setRecording({ blob, mimeType: blob.type, durationMs: elapsed });
        setDurationMs(elapsed);
        setStatus('preview');
      };

      startedAtRef.current = Date.now();
      setDurationMs(0);
      setStatus('recording');
      recorder.start();

      tickRef.current = window.setInterval(() => {
        setDurationMs(Math.min(maxDurationMs, Date.now() - startedAtRef.current));
      }, 200);
      stopTimerRef.current = window.setTimeout(() => recorder.state === 'recording' && recorder.stop(), maxDurationMs);
    } catch (error) {
      teardown();
      const denied = error instanceof DOMException && error.name === 'NotAllowedError';
      setFailure(denied ? 'denied' : 'unavailable');
      setStatus('idle');
    }
  }, [maxDurationMs, teardown]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
      return;
    }
    /* Nothing was recording (the permission prompt is still open, say): going back to
       idle is the only honest state. */
    teardown();
    setStatus('idle');
    setDurationMs(0);
  }, [teardown]);

  /** Throws the recording away. Never uploads — that is the point of cancel. */
  const cancel = useCallback(() => {
    discardRef.current = true;
    const recorder = recorderRef.current;
    if (recorder && recorder.state === 'recording') {
      try {
        recorder.stop();
        return;
      } catch {
        // Fall through to the state reset below.
      }
    }
    teardown();
    setStatus('idle');
    setRecording(null);
    setDurationMs(0);
  }, [teardown]);

  /** Hands the recording to the caller and resets, so a second note starts clean. */
  const take = useCallback((): PendingRecording | null => {
    const result = recording;
    setRecording(null);
    setStatus('idle');
    setDurationMs(0);
    return result;
  }, [recording]);

  return { status, durationMs, failure, recording, start, stop, cancel, take };
}
