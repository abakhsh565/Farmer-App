import { Image as ImageIcon, Mic, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  AUTHORS,
  PLACES,
  TOPICS,
  type Attachment,
  type AuthorId,
  type PlaceId,
  type TopicId,
} from '@/data/community';
import { useLocale } from '@/i18n/LocaleProvider';
import { formatRelativeTime } from '@/i18n/format';
import { initialsOf } from '@/lib/initials';

/**
 * The small parts every community surface draws: a face, the line under a name,
 * and whatever is attached to a post. They live together because they have to
 * look the same on the feed, in a thread and under a reply — four copies of an
 * avatar is how two of them end up with Latin initials on an Urdu screen.
 */

export function AuthorAvatar({
  author,
  size = 'md',
}: {
  author: AuthorId;
  size?: 'sm' | 'md';
}) {
  const { t } = useLocale();
  const { nameKey, tint } = AUTHORS[author];
  const name = t(nameKey);
  const me = author === 'me';

  return (
    <span
      className={`grid shrink-0 place-items-center rounded-full font-medium ${
        size === 'sm' ? 'size-6 text-caption' : 'size-10 text-body-sm'
      } ${me ? 'bg-brand text-brand-foreground' : `${tint} text-white`}`}
    >
      {initialsOf(name)}
    </span>
  );
}

/** The one author the product vouches for, marked wherever they speak. */
export function ExpertBadge() {
  const { t } = useLocale();
  return (
    <span className="inline-flex items-center gap-1 rounded-sm bg-violet-100 px-1.5 py-0.5 text-caption font-medium text-violet-600 dark:bg-violet-500/20 dark:text-violet-100">
      <ShieldCheck className="size-3" aria-hidden />
      {t('community.expert')}
    </span>
  );
}

/**
 * A name, the expert mark when it applies, and the meta line under it.
 *
 * The meta line is assembled rather than typed out — topic, village, and how long
 * ago — because each of those three changes: the village when a farmer moves, the
 * time every minute, the topic when they edit the post.
 */
export function AuthorLine({
  author,
  meta,
  size = 'md',
}: {
  author: AuthorId;
  meta: string;
  size?: 'sm' | 'md';
}) {
  const { t } = useLocale();
  const { nameKey, expert } = AUTHORS[author];

  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <AuthorAvatar author={author} size={size} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className={`truncate ${size === 'sm' ? 'text-body-sm' : 'text-body'} font-medium`}>
            {t(nameKey)}
          </span>
          {expert ? <ExpertBadge /> : null}
        </span>
        <span className="block truncate text-caption text-muted-foreground">{meta}</span>
      </span>
    </span>
  );
}

/**
 * "Cotton · Wazirabad · 2h" — the line the design puts under every name, built
 * from the post's own topic, village and age. Three facts, one of which (the
 * time) changes while the screen is open, so it is assembled and never stored.
 */
export function usePostMeta() {
  const { t } = useLocale();

  return (
    input: { topics: TopicId[]; place: PlaceId; createdAt: number; mine?: boolean },
    now: number,
  ) => {
    const topic = TOPICS.find((entry) => entry.id === input.topics[0]);
    const place = PLACES.find((entry) => entry.id === input.place);

    return [
      input.mine ? t('community.you') : null,
      topic ? t(topic.labelKey) : null,
      place ? t(place.labelKey) : null,
      formatRelativeTime(input.createdAt, now, t),
    ]
      .filter(Boolean)
      .join(' · ');
  };
}

/**
 * What is attached to a post.
 *
 * Three distinct things, kept distinct: the mockup's stand-in picture, a real
 * file the farmer attached in this session, and an attachment whose file is gone
 * because the page was reloaded. Collapsing the last two into one broken image is
 * how a farmer concludes the app lost their photo and stops trusting it.
 */
export function MediaBlock({ attachment }: { attachment: Attachment }) {
  const { t } = useLocale();

  if (attachment.placeholder) {
    return (
      <p className="mt-2.5 flex h-32 w-full items-center justify-center rounded-md bg-muted">
        <ImageIcon className="size-7 text-ink-300" aria-label={t('community.photoAlt')} />
      </p>
    );
  }

  if (!attachment.url) {
    return (
      <p className="mt-2.5 flex items-center gap-2 rounded-md bg-muted px-3 py-2.5 text-body-sm text-muted-foreground">
        <TriangleAlert className="size-4 shrink-0" aria-hidden />
        {t('community.media.unavailable')}
      </p>
    );
  }

  if (attachment.kind === 'image') {
    return (
      <img
        src={attachment.url}
        alt={t('community.photoAlt')}
        className="mt-2.5 h-40 w-full rounded-md object-cover"
      />
    );
  }

  if (attachment.kind === 'video') {
    return (
      // eslint-disable-next-line jsx-a11y/media-has-caption -- a farmer's video has no captions to offer
      <video
        src={attachment.url}
        controls
        className="mt-2.5 h-40 w-full rounded-md bg-ink-950 object-cover"
        aria-label={t('community.videoAlt')}
      />
    );
  }

  return (
    <span className="mt-2.5 flex items-center gap-2 rounded-md bg-muted px-3 py-2">
      <Mic className="size-4 shrink-0 text-brand" aria-hidden />
      <audio src={attachment.url} controls className="h-8 w-full" aria-label={t('community.voice.play')} />
    </span>
  );
}

/** A row of small inline actions: reply, like, the options menu. */
export function ActionRow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`flex items-center gap-3.5 text-body-sm ${className}`}>{children}</div>;
}

/** "4m" / "2h" / "1d" for a timestamp, from the one formatter. */
export function useRelative(createdAt: number, now: number): string {
  const { t } = useLocale();
  return formatRelativeTime(createdAt, now, t);
}
