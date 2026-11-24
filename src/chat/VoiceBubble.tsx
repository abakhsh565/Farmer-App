import { Pause, Play, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ChatAudio } from '@/data/chat';
import { useLocale } from '@/i18n/LocaleProvider';
import { formatDuration } from '@/shop/api/voice';

/**
 * A voice note, played in place.
 *
 * One `<audio>` per bubble, created only when the farmer presses play: a thread with
 * twenty notes should not hold twenty decoders, and a signed URL expires whether or
 * not anything was loaded. The element is thrown away on unmount for the same reason.
 *
 * The states the bubble can be in are the ones a message can actually be in, and each
 * is drawn differently:
 *
 *  · **sending** — the upload's own fraction, so a bar that is stuck at 40% is
 *    visibly stuck rather than a spinner that means nothing;
 *  · **failed** — the shop's sentence plus retry, because the recording is still
 *    here and re-sending it must not mean re-recording it;
 *  · **sent** — play/pause with elapsed time. A note whose URL has not been signed
 *    yet keeps its duration and disables play rather than rendering silence.
 */
export function VoiceBubble({
  audio,
  mine,
  onRetry,
  onDiscard,
}: {
  audio: ChatAudio;
  mine: boolean;
  onRetry?: () => void;
  onDiscard?: () => void;
}) {
  const { t } = useLocale();
  const elementRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  useEffect(
    () => () => {
      elementRef.current?.pause();
      elementRef.current = null;
    },
    [],
  );

  const duration = audio.durationMs > 0 ? audio.durationMs : 0;
  const sending = audio.status === 'sending';
  const failed = audio.status === 'failed';
  const progress = sending ? Math.max(0, Math.min(1, audio.progress ?? 0)) : 0;
  const played = duration > 0 ? Math.min(1, elapsed / duration) : 0;

  const toggle = () => {
    if (!audio.url) return;
    const element = elementRef.current ?? new Audio(audio.url);
    elementRef.current = element;

    if (playing) {
      element.pause();
      setPlaying(false);
      return;
    }

    element.currentTime = 0;
    void element.play().then(
      () => setPlaying(true),
      /* Autoplay blocked or the URL expired: the control returns to "play" rather
         than pretending to play silence. */
      () => setPlaying(false),
    );
    element.ontimeupdate = () => setElapsed(element.currentTime * 1000);
    element.onended = () => {
      setPlaying(false);
      setElapsed(0);
    };
    element.onerror = () => {
      setPlaying(false);
      setElapsed(0);
    };
  };

  const ink = mine ? 'text-brand-foreground' : 'text-foreground';
  const track = mine ? 'bg-brand-foreground/25' : 'bg-foreground/15';
  const fill = mine ? 'bg-brand-foreground' : 'bg-brand';

  return (
    <div className="flex min-w-40 flex-col gap-1.5">
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={toggle}
          disabled={!audio.url || sending || failed}
          aria-label={playing ? t('chat.voice.pause') : t('chat.voice.play')}
          className={`grid size-9 shrink-0 place-items-center rounded-full disabled:opacity-50 ${
            mine ? 'bg-brand-foreground/20' : 'bg-foreground/10'
          }`}
        >
          {playing ? (
            <Pause className={`size-4 ${ink}`} aria-hidden />
          ) : (
            <Play className={`size-4 ${ink} rtl:-scale-x-100`} aria-hidden />
          )}
        </button>

        <span className="flex flex-1 flex-col gap-1">
          <span className={`h-1.5 overflow-hidden rounded-full ${track}`}>
            <span
              className={`block h-full rounded-full ${fill} transition-[width]`}
              style={{ width: `${Math.round((sending ? progress : played) * 100)}%` }}
            />
          </span>
          <span className={`text-caption tabular-nums ${mine ? 'text-brand-foreground/80' : 'text-muted-foreground'}`}>
            {sending
              ? t('chat.voice.uploading', { percent: Math.round(progress * 100) })
              : formatDuration(playing ? elapsed : duration)}
          </span>
        </span>
      </div>

      {failed ? (
        <div className="flex items-center justify-between gap-2">
          <span className={`text-caption ${mine ? 'text-brand-foreground/80' : 'text-muted-foreground'}`}>
            {audio.status === 'failed' ? t('chat.voice.failed') : ''}
          </span>
          <span className="flex gap-1">
            {onRetry ? (
              <button
                type="button"
                onClick={onRetry}
                aria-label={t('chat.voice.retry')}
                className={`grid size-7 place-items-center rounded-full ${mine ? 'bg-brand-foreground/20' : 'bg-foreground/10'}`}
              >
                <RotateCcw className={`size-3.5 ${ink}`} aria-hidden />
              </button>
            ) : null}
            {onDiscard ? (
              <button
                type="button"
                onClick={onDiscard}
                aria-label={t('chat.voice.discard')}
                className={`grid size-7 place-items-center rounded-full ${mine ? 'bg-brand-foreground/20' : 'bg-foreground/10'}`}
              >
                <Trash2 className={`size-3.5 ${ink}`} aria-hidden />
              </button>
            ) : null}
          </span>
        </div>
      ) : null}
    </div>
  );
}
