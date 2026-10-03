import { Clock, Heart, MessageSquare } from 'lucide-react';
import { useCommunity } from '@/community/CommunityProvider';
import { AUTHORS, bodyText, ME, type AuthorId, type Post } from '@/data/community';
import { formatNumber } from '@/i18n/format';
import { useLocale } from '@/i18n/LocaleProvider';
import { PostOptions } from './Moderation';
import { AuthorAvatar, AuthorLine, ExpertBadge, MediaBlock, usePostMeta } from './pieces';

/**
 * One post in the feed: who, what, whatever is attached, the expert's answer when
 * it is the one that opens the thread, and the two things you can do about it.
 *
 * Every number on this card is counted from the thread behind it. The reply count
 * is the number of replies in the store, the expert line is derived from who
 * actually answered, and the like count is state that changes under your thumb —
 * which is the difference between a feed and a picture of one.
 */
export function PostCard({ post }: { post: Post }) {
  const { t, locale } = useLocale();
  const { now, like, replyCount, topAnswer, expertAnswered, commenters, openThread } = useCommunity();
  const postMeta = usePostMeta();

  const text = bodyText(post.body, t);
  const replies = replyCount(post.id);
  const answer = topAnswer(post.id);
  const answered = expertAnswered(post.id);
  const faces = commenters(post.id);
  const mine = post.author === ME;

  /*
   * A deleted post that was answered keeps its row, and the row has to stay a way
   * *into* the thread: the replies are other farmers' words and they are still
   * there. A tombstone that cannot be opened strands the conversation it was kept
   * for.
   */
  if (post.removed) {
    return (
      <li className="rounded-lg border border-dashed border-border bg-card p-3.5">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <AuthorLine
              author={post.author}
              meta={postMeta(
                { topics: post.topics, place: post.place, createdAt: post.createdAt, mine },
                now,
              )}
            />
          </div>
          <PostOptions
            postId={post.id}
            author={post.author}
            target="post"
            reported={post.reported}
          />
        </div>

        <button
          type="button"
          onClick={() => openThread(post.id)}
          className="mt-2.5 w-full text-start"
        >
          <span className="block text-body-sm italic text-muted-foreground">
            {t('community.deleted.body')}
          </span>
        </button>

        <div className="mt-3 flex items-center gap-3.5 text-body-sm text-muted-foreground">
          <button
            type="button"
            onClick={() => openThread(post.id)}
            className="flex items-center gap-1.5"
          >
            <MessageSquare className="size-4" aria-hidden />
            {t('community.replies', { count: replies })}
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="rounded-lg border border-border bg-card p-3.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <AuthorLine
            author={post.author}
            meta={postMeta(
              { topics: post.topics, place: post.place, createdAt: post.createdAt, mine },
              now,
            )}
          />
        </div>
        <PostOptions postId={post.id} author={post.author} target="post" reported={post.reported} />
      </div>

      {post.pending ? (
        <p className="mt-2.5 inline-flex items-center gap-1.5 rounded-sm bg-amber-50 px-2 py-1 text-caption text-amber-700 dark:bg-amber-500/20 dark:text-amber-100">
          <Clock className="size-3 shrink-0" aria-hidden />
          {t('community.pending')}
        </p>
      ) : null}

      {/* The text and the attachment are the tap target — a card whose header is
          also a button gives a screen reader a name it cannot use. */}
      <button
        type="button"
        onClick={() => openThread(post.id)}
        className="mt-2.5 w-full text-start"
      >
        <span className="block text-body leading-relaxed">{text}</span>
        {post.attachment ? <MediaBlock attachment={post.attachment} /> : null}
      </button>

      {answer ? (
        <div className="mt-2.5 flex gap-2 rounded-md bg-muted p-2.5">
          <AuthorAvatar author={answer.author} size="sm" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-body-sm font-medium">
                {t(AUTHORS[answer.author].nameKey)}
              </span>
              <ExpertBadge />
            </div>
            <p className="mt-1 line-clamp-2 text-body-sm text-muted-foreground">
              {bodyText(answer.body, t)}
            </p>
          </div>
        </div>
      ) : null}

      <div className="mt-3 flex items-center gap-3.5 text-body-sm">
        <button
          type="button"
          aria-pressed={post.likedByMe}
          aria-label={t('community.likes', { count: post.likes })}
          onClick={() => like(post.id)}
          className={`flex items-center gap-1.5 ${
            post.likedByMe ? 'text-brand' : 'text-muted-foreground'
          }`}
        >
          <Heart className={`size-4 ${post.likedByMe ? 'fill-current' : ''}`} aria-hidden />
          {formatNumber(post.likes, locale)}
        </button>

        <button
          type="button"
          onClick={() => openThread(post.id)}
          className={`flex min-w-0 items-center gap-2 ${
            answered ? 'text-brand' : 'text-muted-foreground'
          }`}
        >
          {faces.length > 0 ? <FaceStack faces={faces} /> : null}
          <span className="flex items-center gap-1.5 truncate">
            <MessageSquare className="size-4 shrink-0" aria-hidden />
            {t('community.replies', { count: replies })}
            {answered ? <span aria-hidden>·</span> : null}
          </span>
          {answered ? <span className="shrink-0">{t('community.expertAnswered')}</span> : null}
        </button>
      </div>
    </li>
  );
}

/**
 * The first two people who answered, and how many more people there were — the
 * overflow counts *faces*, not replies. A stack of avatars is a crowd, and a "+10"
 * beside two of them reads as ten more farmers, which is what it now means.
 *
 * Overlapped rather than spaced, so a busy thread reads as one crowd instead of
 * two portraits and a number.
 */
function FaceStack({ faces }: { faces: AuthorId[] }) {
  return (
    <span className="flex shrink-0 items-center" aria-hidden>
      {faces.slice(0, 2).map((author, index) => (
        <span
          key={author}
          className={`grid size-6 place-items-center rounded-full ring-2 ring-card ${
            index > 0 ? '-ms-2' : ''
          }`}
        >
          <AuthorAvatar author={author} size="sm" />
        </span>
      ))}
      {faces.length > 2 ? (
        <span className="-ms-2 grid size-6 place-items-center rounded-full bg-muted text-caption text-muted-foreground ring-2 ring-card">
          +{faces.length - 2}
        </span>
      ) : null}
    </span>
  );
}
