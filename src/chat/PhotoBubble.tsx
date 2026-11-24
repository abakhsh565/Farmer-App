import { ImageOff, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ChatImage } from '@/data/chat';
import { useLocale } from '@/i18n/LocaleProvider';

/**
 * A photo in the conversation.
 *
 * The picture is drawn from a *short-lived signed link*, so it is asked for when the
 * bubble appears and never stored: a URL cached in a message would work once and
 * then stop, which looks like a photo the shop deleted. A photo this phone is still
 * sending is drawn from its own bytes (an object URL), so the farmer sees the picture
 * they picked next to its progress instead of a grey placeholder.
 *
 * The three states are the ones a message can be in, and each is drawn differently:
 *
 *  · **sending** — the local picture, dimmed, with the upload's own percentage;
 *  · **failed** — the shop's sentence plus retry and delete, because the photo is
 *    still here and re-sending it must not mean taking it again;
 *  · **sent** — the picture at its own aspect ratio, with no frame around it.
 */
export function PhotoBubble({
  image,
  mine,
  onResolve,
  onRetry,
  onDiscard,
}: {
  image: ChatImage;
  mine: boolean;
  onResolve?: () => Promise<string | null>;
  onRetry?: () => void;
  onDiscard?: () => void;
}) {
  const { t } = useLocale();
  const [url, setUrl] = useState<string | null>(image.url);
  const [failed, setFailed] = useState(false);
  const [localUrl, setLocalUrl] = useState<string | null>(null);

  /* `onResolve` is usually written inline by the screen, so it is a new function on
     every render. Keeping the latest one in a ref is what stops the effect below from
     minting a fresh sixty-second link on each keystroke elsewhere in the thread. */
  const resolveRef = useRef(onResolve);
  resolveRef.current = onResolve;

  /* The bytes this phone holds, for a photo that has not reached the shop yet. */
  useEffect(() => {
    /* An old WebView (and a test runner without object URLs) has no `createObjectURL`.
       The bubble then simply waits for the shop's link instead of throwing. */
    if (!image.localBlob || typeof URL.createObjectURL !== 'function') {
      setLocalUrl(null);
      return;
    }
    const created = URL.createObjectURL(image.localBlob);
    setLocalUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [image.localBlob]);

  /* A sent photo has only a message id: the link is minted here, once. */
  useEffect(() => {
    if (image.url) {
      setUrl(image.url);
      return;
    }
    if (image.localBlob || image.status === 'failed' || image.status === 'sending') return;
    const resolve = resolveRef.current;
    if (!resolve) return;

    let cancelled = false;
    void resolve().then(
      (next) => {
        if (cancelled) return;
        if (next) setUrl(next);
        else setFailed(true);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [image.localBlob, image.serverId, image.status, image.url]);

  const sending = image.status === 'sending';
  const progress = sending ? Math.max(0, Math.min(1, image.progress ?? 0)) : 0;
  const shown = localUrl ?? url;

  return (
    <div className="flex min-w-40 flex-col gap-1.5">
      <div className="relative overflow-hidden rounded-md bg-muted" style={{ maxWidth: 240 }}>
        {shown ? (
          <img
            src={shown}
            alt={t('chat.photo.label')}
            className={`block h-auto w-full object-cover ${sending ? 'opacity-70' : ''}`}
            style={
              image.width && image.height
                ? { aspectRatio: `${image.width} / ${image.height}`, maxWidth: 240 }
                : undefined
            }
          />
        ) : (
          <div className="grid h-28 w-40 place-items-center text-muted-foreground">
            <ImageOff className="size-5" aria-hidden />
          </div>
        )}

        {sending ? (
          <span className="absolute inset-x-0 bottom-0 block h-1 bg-foreground/20">
            <span
              className="block h-full bg-brand transition-[width]"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </span>
        ) : null}
      </div>

      <span className={`text-caption ${mine ? 'text-brand-foreground/80' : 'text-muted-foreground'}`}>
        {sending
          ? t('chat.voice.uploading', { percent: Math.round(progress * 100) })
          : failed
            ? t('chat.photo.unavailable')
            : ''}
      </span>

      {image.status === 'failed' ? (
        <div className="flex items-center justify-between gap-2">
          <span className={`text-caption ${mine ? 'text-brand-foreground/80' : 'text-muted-foreground'}`}>
            {t('chat.photo.failed')}
          </span>
          <span className="flex gap-1">
            {onRetry ? (
              <button
                type="button"
                onClick={onRetry}
                aria-label={t('chat.voice.retry')}
                className={`grid size-7 place-items-center rounded-full ${mine ? 'bg-brand-foreground/20' : 'bg-foreground/10'}`}
              >
                <RotateCcw className={`size-3.5 ${mine ? 'text-brand-foreground' : 'text-foreground'}`} aria-hidden />
              </button>
            ) : null}
            {onDiscard ? (
              <button
                type="button"
                onClick={onDiscard}
                aria-label={t('chat.voice.discard')}
                className={`grid size-7 place-items-center rounded-full ${mine ? 'bg-brand-foreground/20' : 'bg-foreground/10'}`}
              >
                <Trash2 className={`size-3.5 ${mine ? 'text-brand-foreground' : 'text-foreground'}`} aria-hidden />
              </button>
            ) : null}
          </span>
        </div>
      ) : null}
    </div>
  );
}
