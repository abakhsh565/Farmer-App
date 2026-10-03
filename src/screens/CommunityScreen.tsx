import { Plus, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ErrorState, EmptyState, LoadingState } from '@/components/States';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useCommunity } from '@/community/CommunityProvider';
import { AUTHORS, FILTERS } from '@/data/community';
import { useLocale } from '@/i18n/LocaleProvider';
import { initialsOf } from '@/lib/initials';
import { Composer } from '@/components/community/Composer';
import { GuidelinesSheet } from '@/components/community/Moderation';
import { PostCard } from '@/components/community/PostCard';
import { StoryRow, StoryViewer } from '@/components/community/Stories';
import { ThreadView } from '@/components/community/ThreadView';

/**
 * The Community tab: what nearby farmers are asking, and what they have learned.
 *
 * The screen is a renderer. Everything with a rule in it — the feed order, the
 * counts, what a block hides, whether a post may be published at all — lives in
 * `src/community`, which is why this file has no arithmetic in it. What is left
 * here is the part that is genuinely about the screen: which of the four states
 * to show, which sheet is open, and where the two floating buttons sit.
 */
export function CommunityScreen() {
  const { t } = useLocale();
  const {
    status,
    retry,
    posts,
    hidden,
    filter,
    setFilter,
    openPost,
    closeThread,
    online,
    unblock,
    viewingStoryId,
  } = useCommunity();
  const [sheet, setSheet] = useState<'post' | 'story' | null>(null);

  /*
   * Leaving the tab closes the thread, so coming back lands on the feed — the same
   * behaviour the chat screen has, and the reason its `openThreadKey` is cleared in
   * the shell. The *draft* survives, because it lives in the store: a half-written
   * reply is not something to lose because somebody checked a price.
   *
   * The callback is read through a ref on purpose. `closeThread` is a new function
   * whenever the feed's state changes, so listing it as a dependency would make the
   * cleanup fire on every update — and since the cleanup changes that same state,
   * it would fire again, for ever.
   */
  const closeThreadRef = useRef(closeThread);
  closeThreadRef.current = closeThread;
  useEffect(() => () => closeThreadRef.current(), []);

  if (openPost) return <ThreadView />;

  const isAll = filter === 'all';

  return (
    <div className="flex min-h-full flex-col px-4 pt-4">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-title">{t('community.title')}</h1>
        <div className="flex shrink-0 items-center gap-2">
          <GuidelinesSheet>
            <button
              type="button"
              aria-label={t('community.guidelines.open')}
              className="grid size-10 place-items-center rounded-full bg-muted"
            >
              <ShieldCheck className="size-5" aria-hidden />
            </button>
          </GuidelinesSheet>
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand text-caption font-medium text-brand-foreground">
            {initialsOf(t('farmer.name'))}
          </span>
        </div>
      </header>

      <StoryRow onAdd={() => setSheet('story')} />

      <ul className="mt-3.5 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {FILTERS.map((entry) => {
          const active = entry.id === filter;
          return (
            <li key={entry.id} className="shrink-0">
              <button
                type="button"
                aria-pressed={active}
                onClick={() => setFilter(entry.id)}
                className={`rounded-full px-3.5 py-2 text-body-sm font-medium leading-none ${
                  active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                }`}
              >
                {t(entry.labelKey)}
              </button>
            </li>
          );
        })}
      </ul>

      {!online ? (
        <p className="mt-3 flex gap-2 rounded-md bg-muted px-3 py-2.5 text-body-sm text-muted-foreground">
          <TriangleAlert className="size-4 shrink-0" aria-hidden />
          {t('community.offline')}
        </p>
      ) : null}

      {/* A block is only honest if it says what it is hiding and can be undone. */}
      {hidden.map((entry) => (
        <p
          key={entry.author}
          className="mt-3 flex items-center gap-2 rounded-md bg-muted px-3 py-2.5 text-body-sm text-muted-foreground"
        >
          <span className="min-w-0 flex-1 truncate">
            {t('community.blocked.notice', { name: t(AUTHORS[entry.author].nameKey) })}
          </span>
          <button
            type="button"
            onClick={() => unblock(entry.author)}
            className="shrink-0 font-medium text-brand"
          >
            {t('community.action.unblock', { name: t(AUTHORS[entry.author].nameKey) })}
          </button>
        </p>
      ))}

      {status === 'loading' ? <LoadingState label={t('community.loading')} /> : null}

      {status === 'error' ? (
        <ErrorState
          title={t('community.error')}
          body={t('community.errorBody')}
          retryLabel={t('common.tryAgain')}
          onRetry={retry}
        />
      ) : null}

      {status === 'ready' && posts.length === 0 ? (
        <EmptyState
          icon={TriangleAlert}
          title={t('community.empty.title')}
          body={t(isAll ? 'community.empty.body' : 'community.empty.filterBody')}
          action={
            isAll ? (
              <Button
                className="h-11 rounded-full"
                onClick={() => setSheet('post')}
              >
                <Plus className="size-4" aria-hidden />
                {t('community.post')}
              </Button>
            ) : (
              <Button
                variant="outline"
                className="h-11 rounded-full"
                onClick={() => setFilter('all')}
              >
                {t('community.empty.showAll')}
              </Button>
            )
          }
        />
      ) : null}

      {status === 'ready' && posts.length > 0 ? (
        <ul className="mt-3 space-y-3">
          {posts.map((post) => (
            <PostCard key={post.id} post={post} />
          ))}
        </ul>
      ) : null}

      {/* Held on the tab bar rather than in the shell, so it only appears where it
          belongs. */}
      <div className="sticky bottom-4 z-10 mt-auto flex justify-end pt-4">
        <button
          type="button"
          aria-label={t('community.composeAria')}
          onClick={() => setSheet('post')}
          className="grid size-13 place-items-center rounded-full bg-brand text-brand-foreground shadow-lg"
        >
          <Plus className="size-6" aria-hidden />
        </button>
      </div>

      <Sheet open={sheet === 'post'} onOpenChange={(next) => setSheet(next ? 'post' : null)}>
        <SheetContent side="bottom" className="mx-auto max-h-[85dvh] w-full max-w-[430px] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{t('community.newPost')}</SheetTitle>
          </SheetHeader>
          <Composer mode="post" onClose={() => setSheet(null)} />
        </SheetContent>
      </Sheet>

      <Sheet open={sheet === 'story'} onOpenChange={(next) => setSheet(next ? 'story' : null)}>
        <SheetContent side="bottom" className="mx-auto w-full max-w-[430px]">
          <SheetHeader>
            <SheetTitle>{t('community.story.yours')}</SheetTitle>
          </SheetHeader>
          <Composer mode="story" onClose={() => setSheet(null)} />
        </SheetContent>
      </Sheet>

      {viewingStoryId ? <StoryViewer /> : null}
    </div>
  );
}
