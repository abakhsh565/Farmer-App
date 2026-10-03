import { Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useCommunity } from '@/community/CommunityProvider';
import { AUTHORS, bodyText, type AuthorId, type Story } from '@/data/community';
import { useLocale } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/catalog';
import { initialsOf } from '@/lib/initials';
import { MediaBlock } from './pieces';

/**
 * Stories: the row of rings at the top of the feed, and the viewer one opens into.
 *
 * A story is a post with a shelf life — 24 hours — and one difference that
 * matters: it is read one at a time in a viewer, and *reading* it is what marks it
 * seen. So the ring's colour is derived from the same `seen` flag the viewer sets,
 * rather than from a second list of "new" ids that would go stale the first time
 * somebody tapped a ring and left.
 */

/** The short names under the rings, which are not the names on a post. */
const RING_LABEL: Partial<Record<AuthorId, MessageKey>> = {
  sajid: 'community.story.sajid',
  rafiq: 'community.story.rafiq',
  amna: 'community.story.amna',
  me: 'community.you',
};

function labelKeyFor(story: Story): MessageKey {
  return RING_LABEL[story.author] ?? AUTHORS[story.author].nameKey;
}

export function StoryRow({ onAdd }: { onAdd: () => void }) {
  const { t } = useLocale();
  const { stories, openStory } = useCommunity();

  return (
    <ul className="mt-3.5 flex gap-3.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <li className="shrink-0 text-center">
        <button
          type="button"
          aria-label={t('community.story.yours')}
          onClick={onAdd}
          className="grid size-14 place-items-center rounded-full border-2 border-dashed border-ink-300"
        >
          <Plus className="size-5 text-muted-foreground" aria-hidden />
        </button>
        <span className="mt-1 block text-caption text-muted-foreground">{t('community.add')}</span>
      </li>

      {stories.map((story) => (
        <li key={story.id} className="shrink-0 text-center">
          <button
            type="button"
            aria-label={t('community.story.viewer', { name: t(labelKeyFor(story)) })}
            onClick={() => openStory(story.id)}
            className={`grid size-14 place-items-center rounded-full p-[2.5px] ${
              story.seen ? 'bg-ink-200' : 'bg-gradient-to-br from-brand to-clay-800'
            }`}
          >
            <span className="grid size-full place-items-center rounded-full bg-card p-[2px]">
              <span className="grid size-full place-items-center rounded-full bg-brand-soft text-body-sm text-brand">
                {initialsOf(t(AUTHORS[story.author].nameKey))}
              </span>
            </span>
          </button>
          <span className="mt-1 block text-caption text-muted-foreground">
            {t(labelKeyFor(story))}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** How long a story stays up before the next one takes its place. */
const STORY_MS = 5000;

export function StoryViewer() {
  const { t } = useLocale();
  const { stories, viewingStoryId, seeStory, openStory, closeStory } = useCommunity();
  const [filled, setFilled] = useState(false);

  const index = stories.findIndex((entry) => entry.id === viewingStoryId);
  const story = index >= 0 ? stories[index] : undefined;

  /*
   * The timers below must not be reset by a re-render, and the feed re-renders on
   * every state change — a new story array, a new setter — so the values they need
   * are read through refs. Depending on them directly is not merely wasteful: the
   * effect sets state, which re-renders, which changes the deps, which runs the
   * effect again, forever.
   */
  const latest = useRef({ nextId: null as string | null, open: openStory, close: closeStory });
  latest.current = {
    nextId: stories[index + 1]?.id ?? null,
    open: openStory,
    close: closeStory,
  };

  /*
   * Reading a story is what marks it read. Doing it in an effect rather than in
   * the tap handler also covers the story that arrives *because* the previous one
   * ran out, which is exactly the case a handler forgets.
   */
  useEffect(() => {
    if (story) seeStory(story.id);
    // Keyed on the story, not on the setter: the setter is a new function every
    // render and would loop.
  }, [story?.id]);

  useEffect(() => {
    if (!story) return;

    // The bar is restarted by remounting its width, which is why `filled` flips
    // around a frame instead of being animated from the state directly.
    setFilled(false);
    const frame = window.requestAnimationFrame(() => setFilled(true));

    const timer = window.setTimeout(() => {
      const { nextId, open, close } = latest.current;
      if (nextId) open(nextId);
      else close();
    }, STORY_MS);

    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [index, story?.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') latest.current.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!story) return null;

  const back = () => {
    const previous = index > 0 ? stories[index - 1] : undefined;
    if (previous) openStory(previous.id);
  };
  const forward = () => {
    const next = stories[index + 1];
    if (next) openStory(next.id);
    else closeStory();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('community.story.viewer', { name: t(labelKeyFor(story)) })}
      className="fixed inset-0 z-50 flex justify-center bg-ink-950/95"
    >
      <div className="flex w-full max-w-[430px] flex-col p-4">
        <div className="flex gap-1.5">
          {stories.map((entry, position) => (
            <span key={entry.id} className="h-0.5 flex-1 overflow-hidden rounded-full bg-white/30">
              <span
                className="block h-full bg-white transition-[width] duration-[5000ms] ease-linear"
                style={{
                  width:
                    position < index
                      ? '100%'
                      : position === index
                        ? filled
                          ? '100%'
                          : '0%'
                        : '0%',
                }}
              />
            </span>
          ))}
        </div>

        <div className="mt-3 flex items-center gap-2.5">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-white/15 text-body-sm text-cream-50">
            {initialsOf(t(AUTHORS[story.author].nameKey))}
          </span>
          <span className="min-w-0 flex-1 truncate text-body font-medium text-cream-50">
            {t(labelKeyFor(story))}
          </span>
          <button
            type="button"
            aria-label={t('community.story.close')}
            onClick={closeStory}
            className="grid size-9 shrink-0 place-items-center rounded-full text-cream-50"
          >
            <X className="size-5" aria-hidden />
          </button>
        </div>

        <div className="relative mt-4 flex flex-1 items-center justify-center">
          <div className="w-full rounded-lg bg-cream-50/10 p-4">
            <p className="text-lead text-cream-50">{bodyText(story.body, t)}</p>
            {story.attachment ? <MediaBlock attachment={story.attachment} /> : null}
          </div>

          {/* Tap zones rather than arrows: this is the gesture a story viewer is
              expected to answer to. Both stay real buttons, so they are still
              reachable from a keyboard. */}
          <button
            type="button"
            aria-label={t('community.story.previous')}
            onClick={back}
            className="absolute inset-y-0 start-0 w-1/3"
          />
          <button
            type="button"
            aria-label={t('community.story.next')}
            onClick={forward}
            className="absolute inset-y-0 end-0 w-2/3"
          />
        </div>
      </div>
    </div>
  );
}
