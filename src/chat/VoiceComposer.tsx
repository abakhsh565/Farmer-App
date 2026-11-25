import { Mic, Play, Square, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useLocale } from '@/i18n/LocaleProvider';
import { formatDuration } from '@/shop/api/media';
import type { PendingRecording, RecorderFailure, RecorderStatus } from './useVoiceRecorder';

/**
 * The recording bar that replaces the composer while a voice note is being made.
 *
 * Two phases, drawn as two bars rather than a modal: the farmer is mid-conversation,
 * and taking the thread off screen to record into it would hide the message they are
 * answering.
 *
 *  · **recording** — elapsed time and a stop control. Cancel is always available:
 *    a recording that cannot be thrown away before it is sent is a recording the
 *    farmer sends by accident.
 *  · **preview** — the actual audio, playable, with the duration and a send button.
 *
 * Nothing here talks to the shop. Sending is the screen's job, which is what keeps
 * "recorded" and "sent" two different words.
 */
export function VoiceComposer({
  status,
  durationMs,
  recording,
  onStop,
  onCancel,
  onSend,
}: {
  status: RecorderStatus;
  durationMs: number;
  recording: PendingRecording | null;
  onStop: () => void;
  onCancel: () => void;
  onSend: (recording: PendingRecording) => void;
}) {
  const { t } = useLocale();
  const previewRef = useRef<HTMLAudioElement | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);

  /* One object URL for the blob, revoked when it changes or the bar goes away —
     otherwise every recording leaks the whole file into the page. */
  useEffect(() => {
    if (!recording) {
      setPreviewUrl(null);
      setPlaying(false);
      return;
    }
    const url = URL.createObjectURL(recording.blob);
    setPreviewUrl(url);
    return () => {
      previewRef.current?.pause();
      previewRef.current = null;
      setPlaying(false);
      URL.revokeObjectURL(url);
    };
  }, [recording]);

  const togglePreview = () => {
    if (!previewUrl) return;
    const element = previewRef.current ?? new Audio(previewUrl);
    previewRef.current = element;
    if (playing) {
      element.pause();
      setPlaying(false);
      return;
    }
    element.currentTime = 0;
    void element.play().then(
      () => setPlaying(true),
      () => setPlaying(false),
    );
    element.onended = () => setPlaying(false);
  };

  if (status === 'recording') {
    return (
      <div className="flex items-center gap-3 border-t border-border p-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-full bg-destructive/10">
          <Mic className="size-5 text-destructive" aria-hidden />
        </span>
        <span className="flex-1 text-body-sm tabular-nums" aria-live="polite">
          {t('chat.voice.recording', { duration: formatDuration(durationMs) })}
        </span>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-11 shrink-0 rounded-full"
          aria-label={t('chat.voice.cancel')}
          onClick={onCancel}
        >
          <Trash2 className="size-4" aria-hidden />
        </Button>
        <Button
          type="button"
          size="icon"
          className="size-11 shrink-0 rounded-full"
          aria-label={t('chat.voice.stop')}
          onClick={onStop}
        >
          <Square className="size-4" aria-hidden />
        </Button>
      </div>
    );
  }

  if (status === 'preview' && recording) {
    return (
      <div className="flex items-center gap-3 border-t border-border p-3">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-11 shrink-0 rounded-full"
          aria-label={playing ? t('chat.voice.pause') : t('chat.voice.play')}
          onClick={togglePreview}
        >
          <Play className="size-4 rtl:-scale-x-100" aria-hidden />
        </Button>
        <span className="flex-1 text-body-sm tabular-nums">
          {t('chat.voice.preview', { duration: formatDuration(recording.durationMs) })}
        </span>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-11 shrink-0 rounded-full"
          aria-label={t('chat.voice.cancel')}
          onClick={onCancel}
        >
          <Trash2 className="size-4" aria-hidden />
        </Button>
        <Button
          type="button"
          size="icon"
          className="size-11 shrink-0 rounded-full"
          aria-label={t('chat.voice.send')}
          onClick={() => onSend(recording)}
        >
          <Mic className="size-4" aria-hidden />
        </Button>
      </div>
    );
  }

  return null;
}

/** The sentence a failure deserves, or `null` when nothing went wrong. */
export function useRecorderFailureText(failure: RecorderFailure | null): string | null {
  const { t } = useLocale();
  if (failure === 'denied') return t('chat.voice.denied');
  if (failure === 'unavailable') return t('chat.voice.unavailable');
  if (failure === 'empty') return t('chat.voice.tooShort');
  return null;
}
