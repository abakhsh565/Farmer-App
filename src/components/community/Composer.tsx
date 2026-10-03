import { Camera, Mic, Send, TriangleAlert, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { SectionLabel } from '@/components/SectionLabel';
import { Button } from '@/components/ui/button';
import { useCommunity } from '@/community/CommunityProvider';
import { maxLengthFor } from '@/community/store';
import { checkAttachment, isEmpty, isTooLong } from '@/community/validate';
import { useSession } from '@/session/SessionProvider';
import { AUTHORS, KINDS, PLACES, TOPICS, type PlaceId, type TopicId } from '@/data/community';
import { ASK_TIPS, ATTACHMENT_MAX_BYTES, VOICE_MAX_MS } from '@/data/community-rules';
import { useLocale } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/catalog';
import { MediaBlock } from './pieces';

/**
 * Writing something: a question, an update, a story, or a reply.
 *
 * One component for all four because they are the same act with different limits
 * and different amounts of ceremony around them — and because a second composer
 * for replies is how replies end up unable to carry the photo that would answer
 * the question.
 *
 * Everything the farmer can do wrong is answered on the screen, under the control
 * they touched: an empty post, one that is too long, a term the rules do not
 * allow, posting the same thing twice, a file that is too big or the wrong kind,
 * a microphone that will not start. A dead button that explains nothing is the
 * failure mode this deliberately avoids — the control is always live and always
 * says why not.
 */

export type ComposerMode = 'post' | 'story' | 'comment';

export function Composer({ mode, onClose }: { mode: ComposerMode; onClose: () => void }) {
  const { t } = useLocale();
  const {
    draft,
    replyDraft,
    updateDraft,
    updateReply,
    publish,
    publishStory,
    reply,
    online,
    openComments,
  } = useCommunity();

  const { requestIdentity } = useSession();
  const [error, setError] = useState<MessageKey | null>(null);
  const [recording, setRecording] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stopTimer = useRef<number | null>(null);

  const isComment = mode === 'comment';
  const target = isComment ? replyDraft : draft;
  const patch = isComment ? updateReply : updateDraft;
  const max = maxLengthFor(mode === 'story' ? 'story' : isComment ? 'comment' : 'post');
  const text = target.text;
  const attachment = target.attachment;
  const over = isTooLong(text, max);

  const parent = isComment
    ? openComments.find((comment) => comment.id === replyDraft.parentId)
    : undefined;

  /*
   * Object URLs are memory the browser holds for us, so they are released when
   * the attachment is replaced or removed, and once more if the box goes away with
   * one still attached. A composer that leaks a 10 MB video per attempt is a
   * composer that runs a farmer's phone out of memory by the afternoon.
   */
  const owned = useRef<string[]>([]);
  const release = (url: string) => {
    if (url) URL.revokeObjectURL(url);
    owned.current = owned.current.filter((entry) => entry !== url);
  };
  useEffect(() => () => owned.current.forEach((url) => URL.revokeObjectURL(url)), []);

  const canRecord =
    typeof MediaRecorder !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia);

  const attach = (file: File | undefined) => {
    if (!file) return;
    const problem = checkAttachment(file);
    if (problem) {
      setError(problem);
      return;
    }
    if (attachment?.url) release(attachment.url);

    const url = URL.createObjectURL(file);
    owned.current.push(url);
    setError(null);
    patch({
      attachment: {
        kind: file.type.startsWith('video/') ? 'video' : 'image',
        url,
        name: file.name,
      },
    });
  };

  const clearAttachment = () => {
    if (attachment?.url) release(attachment.url);
    patch({ attachment: null });
  };

  const stopRecording = () => {
    if (stopTimer.current) window.clearTimeout(stopTimer.current);
    stopTimer.current = null;
    recorder.current?.stop();
    setRecording(false);
  };

  const startRecording = async () => {
    if (!canRecord) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const next = new MediaRecorder(stream);
      const startedAt = Date.now();

      next.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      next.onstop = () => {
        // Releasing the microphone matters: a recording dot that stays on after
        // the farmer stops is the kind of thing they are right not to trust.
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunks, { type: next.mimeType || 'audio/webm' });
        const url = URL.createObjectURL(blob);
        owned.current.push(url);
        patch({
          attachment: {
            kind: 'voice',
            url,
            name: `${Date.now()}.webm`,
            durationMs: Date.now() - startedAt,
          },
        });
      };

      recorder.current = next;
      next.start();
      setRecording(true);
      setError(null);
      // A voice message is a sentence or two; recording stops itself so nobody has
      // to remember to.
      stopTimer.current = window.setTimeout(stopRecording, VOICE_MAX_MS);
    } catch {
      setError('community.error.mic');
    }
  };

  /*
   * The identity gate. Validation that needs no account runs first — a farmer is
   * not asked to sign up for an empty box — and then the *same* submit runs after
   * sign-in, so the words in the box are the words that get posted.
   */
  const submit = () => {
    if (isEmpty(text)) {
      setError('community.error.empty');
      return;
    }
    if (over) {
      setError('community.error.long');
      return;
    }
    requestIdentity(
      runSubmit,
      isComment ? 'session.why.reply' : mode === 'story' ? 'session.why.story' : 'session.why.post',
    );
  };

  const runSubmit = () => {
    const result = isComment ? reply() : mode === 'story' ? publishStory() : publish();
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    toast.success(t(isComment ? 'community.replied' : 'community.posted'));
    onClose();
  };

  const errorLine = error ? (
    <p
      role="alert"
      className="flex items-center gap-2 rounded-md bg-red-50 px-3 py-2.5 text-body-sm text-red-700 dark:bg-red-500/20 dark:text-red-100"
    >
      <TriangleAlert className="size-4 shrink-0" aria-hidden />
      {/* `size` is the attachment rule's own placeholder, so one line of copy can
          speak for either limit. */}
      {t(error, { max, size: Math.round(ATTACHMENT_MAX_BYTES / (1024 * 1024)) })}
    </p>
  ) : null;

  const attachmentBlock = attachment ? (
    <div className="rounded-md border border-border p-2">
      <MediaBlock attachment={attachment} />
      <button
        type="button"
        onClick={clearAttachment}
        className="mt-2 flex items-center gap-1.5 text-body-sm text-muted-foreground"
      >
        <X className="size-4" aria-hidden />
        {t('community.attach.remove')}
      </button>
    </div>
  ) : null;

  const mediaButtons = (
    <>
      <button
        type="button"
        aria-label={t('community.attach.photo')}
        onClick={() => fileInput.current?.click()}
        className="grid size-11 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"
      >
        <Camera className="size-5" aria-hidden />
      </button>
      <input
        ref={fileInput}
        type="file"
        accept="image/*,video/*"
        className="sr-only"
        onChange={(event) => {
          attach(event.target.files?.[0]);
          // Cleared so the same file can be picked again after a remove.
          event.target.value = '';
        }}
      />
      {canRecord ? (
        <button
          type="button"
          aria-label={recording ? t('community.voice.recording') : t('community.attach.voice')}
          aria-pressed={recording}
          onClick={recording ? stopRecording : startRecording}
          className={`grid size-11 shrink-0 place-items-center rounded-full ${
            recording ? 'bg-brand-soft text-brand' : 'bg-muted text-muted-foreground'
          }`}
        >
          <Mic className="size-5" aria-hidden />
        </button>
      ) : null}
    </>
  );

  const offlineNote = !online ? (
    <p className="flex gap-2 rounded-md bg-muted px-3 py-2.5 text-body-sm text-muted-foreground">
      <TriangleAlert className="size-4 shrink-0" aria-hidden />
      {t('community.offline')}
    </p>
  ) : null;

  /* ── a reply: one row, at the foot of the thread it belongs to ─────────── */
  if (isComment) {
    return (
      <div className="flex flex-col gap-2 p-3">
        {parent ? (
          <p className="flex items-center gap-2 text-label text-muted-foreground">
            <span className="truncate">
              {t('community.reply.to', { name: t(AUTHORS[parent.author].nameKey) })}
            </span>
            <button
              type="button"
              onClick={() => updateReply({ parentId: null })}
              className="shrink-0 rounded-full bg-muted px-2 py-1"
            >
              {t('common.cancel')}
            </button>
          </p>
        ) : null}

        {attachmentBlock}
        {errorLine}

        <div className="flex items-end gap-2">
          {mediaButtons}
          <label className="sr-only" htmlFor="community-reply">
            {t('community.reply.placeholder')}
          </label>
          <textarea
            id="community-reply"
            rows={1}
            value={text}
            onChange={(event) => {
              updateReply({ text: event.target.value });
              if (error) setError(null);
            }}
            placeholder={t('community.reply.placeholder')}
            className="max-h-28 min-h-11 min-w-0 flex-1 resize-none rounded-md bg-muted px-3.5 py-3 text-body placeholder:text-muted-foreground focus-visible:outline-none"
          />
          <Button
            size="icon"
            className="size-11 shrink-0 rounded-full"
            aria-label={t('community.reply')}
            onClick={submit}
          >
            <Send className="size-4 rtl:rotate-180" aria-hidden />
          </Button>
        </div>
      </div>
    );
  }

  /* ── a post or a story: the sheet the two floating buttons open ────────── */
  return (
    <div className="flex flex-col gap-3 p-4 pt-0">
      {offlineNote}

      {mode === 'post' ? (
        <div className="flex gap-2">
          {KINDS.map((kind) => (
            <Chip
              key={kind.id}
              active={draft.kind === kind.id}
              label={t(kind.labelKey)}
              onClick={() => updateDraft({ kind: kind.id })}
              stretch
            />
          ))}
        </div>
      ) : null}

      <label className="sr-only" htmlFor={`community-${mode}`}>
        {mode === 'story' ? t('community.story.placeholder') : placeholderKey(draft.kind)}
      </label>
      <textarea
        id={`community-${mode}`}
        rows={mode === 'story' ? 3 : 4}
        value={text}
        onChange={(event) => {
          updateDraft({ text: event.target.value });
          if (error) setError(null);
        }}
        placeholder={mode === 'story' ? t('community.story.placeholder') : t(placeholderKey(draft.kind))}
        className="w-full resize-none rounded-md bg-muted px-3.5 py-3 text-body placeholder:text-muted-foreground focus-visible:outline-none"
      />

      <p
        className={`text-end text-label ${over ? 'text-destructive' : 'text-muted-foreground'}`}
      >
        {text.trim().length}/{max}
      </p>

      {attachmentBlock}

      {mode === 'post' ? (
        <>
          <SectionLabel>{t('community.topic')}</SectionLabel>
          <div className="flex flex-wrap gap-2">
            {TOPICS.map((topic) => (
              <Chip
                key={topic.id}
                active={draft.topics.includes(topic.id)}
                label={t(topic.labelKey)}
                onClick={() => updateDraft({ topics: toggleTopic(draft.topics, topic.id) })}
              />
            ))}
          </div>

          <SectionLabel>{t('community.place')}</SectionLabel>
          <div className="flex flex-wrap gap-2">
            {PLACES.map((place) => (
              <Chip
                key={place.id}
                active={draft.place === place.id}
                label={t(place.labelKey)}
                onClick={() => updateDraft({ place: place.id as PlaceId })}
              />
            ))}
          </div>
        </>
      ) : null}

      {mode === 'post' && draft.kind === 'question' ? (
        <div className="rounded-md bg-muted p-3">
          <p className="text-body-sm font-medium">{t('community.tip.title')}</p>
          <ul className="mt-1.5 space-y-1">
            {ASK_TIPS.map((key) => (
              <li key={key} className="flex gap-2 text-body-sm text-muted-foreground">
                <span aria-hidden>·</span>
                {t(key)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {errorLine}

      <div className="flex items-center gap-2">
        {mediaButtons}
        <Button className="h-11 flex-1 rounded-full" onClick={submit}>
          {mode === 'story' ? t('community.add') : t('community.post')}
        </Button>
      </div>
    </div>
  );
}

/** The prompt above the box changes with the kind of post being written. */
function placeholderKey(kind: 'question' | 'update'): MessageKey {
  return kind === 'question' ? 'community.placeholder.question' : 'community.placeholder.update';
}

function Chip({
  active,
  label,
  onClick,
  stretch,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  stretch?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-full px-3.5 py-2 text-body-sm font-medium leading-none ${
        stretch ? 'flex-1' : ''
      } ${active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
    >
      {label}
    </button>
  );
}

/** Tapping the only chosen topic again keeps it — a question with no topic is unlabelled. */
function toggleTopic(topics: TopicId[], id: TopicId): TopicId[] {
  if (topics.includes(id)) {
    return topics.length === 1 ? topics : topics.filter((entry) => entry !== id);
  }
  return [...topics, id];
}
