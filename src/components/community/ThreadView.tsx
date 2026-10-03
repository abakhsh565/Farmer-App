import { ChevronLeft, Heart, MessageSquare } from 'lucide-react';
import { useCommunity } from '@/community/CommunityProvider';
import { AUTHORS, bodyText, ME } from '@/data/community';
import { formatNumber, formatRelativeTime } from '@/i18n/format';
import { useLocale } from '@/i18n/LocaleProvider';
import { Composer } from './Composer';
import { PostOptions } from './Moderation';
import { AuthorAvatar, ExpertBadge, MediaBlock, usePostMeta } from './pieces';

/**
 * One post and the conversation under it.
 *
 * The replies are nested, and they keep the order they were written in rather
 * than being sorted by anything clever: a farmer following a thread is reading a
 * conversation, and a conversation reordered by votes is not one. Two levels of
 * indent, then depth stops — beyond that the text column is too narrow for the
 * Urdu to be readable, and a reply's place in the thread is already carried by
 * who it answers.
 */
export function ThreadView() {
  const { t, locale } = useLocale();
  const {
    openPost,
    rows,
    now,
    closeThread,
    like,
    replyCount,
    replyDraft,
    updateReply,
  } = useCommunity();
  const postMeta = usePostMeta();

  if (!openPost) return null;

  const replies = replyCount(openPost.id);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <button
          type="button"
          aria-label={t('common.back')}
          onClick={closeThread}
          className="-ms-2 grid size-9 shrink-0 place-items-center rounded-full"
        >
          <ChevronLeft className="size-5 rtl:rotate-180" aria-hidden />
        </button>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-subheading">
            {t(AUTHORS[openPost.author].nameKey)}
          </span>
          <span className="block truncate text-caption text-muted-foreground">
            {postMeta(
              {
                topics: openPost.topics,
                place: openPost.place,
                createdAt: openPost.createdAt,
                mine: openPost.author === ME,
              },
              now,
            )}
          </span>
        </span>
        <PostOptions
          postId={openPost.id}
          author={openPost.author}
          target="post"
          reported={openPost.reported}
        />
      </header>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {openPost.removed ? (
          <p className="mt-4 rounded-md border border-dashed border-border p-3.5 text-body-sm text-muted-foreground">
            {t('community.deleted.body')}
          </p>
        ) : (
          <div className="pt-4">
            <p className="text-body leading-relaxed">{bodyText(openPost.body, t)}</p>
            {openPost.attachment ? <MediaBlock attachment={openPost.attachment} /> : null}

            <div className="mt-3 flex items-center gap-3.5 text-body-sm text-muted-foreground">
              <button
                type="button"
                aria-pressed={openPost.likedByMe}
                aria-label={t('community.likes', { count: openPost.likes })}
                onClick={() => like(openPost.id)}
                className={`flex items-center gap-1.5 ${
                  openPost.likedByMe ? 'text-brand' : 'text-muted-foreground'
                }`}
              >
                <Heart
                  className={`size-4 ${openPost.likedByMe ? 'fill-current' : ''}`}
                  aria-hidden
                />
                {formatNumber(openPost.likes, locale)}
              </button>
              <span className="flex items-center gap-1.5">
                <MessageSquare className="size-4" aria-hidden />
                {t('community.replies', { count: replies })}
              </span>
            </div>
          </div>
        )}

        {rows.length > 0 ? (
          <ul className="mt-4 space-y-3.5">
            {rows.map(({ comment, depth }) => {
              const name = t(AUTHORS[comment.author].nameKey);
              const answeringMe = replyDraft.parentId === comment.id;
              return (
                <li
                  key={comment.id}
                  className={depth > 0 ? 'ps-6' : undefined}
                  data-depth={depth}
                >
                  <div className="flex gap-2.5">
                    <AuthorAvatar author={comment.author} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-body-sm font-medium">{name}</span>
                        {AUTHORS[comment.author].expert ? <ExpertBadge /> : null}
                        <span className="text-caption text-muted-foreground">
                          {formatRelativeTime(comment.createdAt, now, t)}
                        </span>
                      </div>

                      {comment.removed ? (
                        <p className="mt-1 text-body-sm italic text-muted-foreground">
                          {t('community.deleted.reply')}
                        </p>
                      ) : (
                        <>
                          <p className="mt-1 text-body-sm leading-relaxed">
                            {bodyText(comment.body, t)}
                          </p>
                          {comment.attachment ? <MediaBlock attachment={comment.attachment} /> : null}
                        </>
                      )}

                      <div className="mt-1.5 flex items-center gap-2">
                        {/* Tapping the reply you are already writing to lets go of it, so
                            the same control answers and cancels. */}
                        <button
                          type="button"
                          aria-pressed={answeringMe}
                          aria-label={t('community.reply.aria', { name })}
                          onClick={() => updateReply({ parentId: answeringMe ? null : comment.id })}
                          className={`rounded-full px-2.5 py-1 text-label ${
                            answeringMe ? 'bg-brand-soft text-brand' : 'bg-muted text-muted-foreground'
                          }`}
                        >
                          {t('community.reply')}
                        </button>
                        <PostOptions
                          postId={openPost.id}
                          commentId={comment.id}
                          author={comment.author}
                          target="comment"
                          reported={comment.reported}
                        />
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      {/* The reply box stays at the foot of the thread rather than in a sheet:
          answering somebody is part of reading what they said. */}
      <div className="border-t border-border">
        <Composer mode="comment" onClose={() => undefined} />
      </div>
    </div>
  );
}
