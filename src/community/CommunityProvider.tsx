import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AuthorId, Comment, Post, Story } from '@/data/community';
import type { FilterId } from '@/data/community';
import type { ReportReasonId } from '@/data/community-rules';
import { ownerFor, useOnline, usePersistentDocument } from '@/services/persistence';
import { useSession } from '@/session/SessionProvider';
import {
  addComment,
  addPost,
  addStory,
  blockAuthor,
  closeStory as closeStoryIn,
  commenters,
  createState,
  expertAnswered as expertAnsweredFor,
  flushPending,
  hasPending,
  hiddenByBlock,
  hydrate,
  markReported,
  openStory as openStoryIn,
  postById,
  removeEntry,
  replyCount as replyCountFor,
  seeStory as seeStoryFor,
  serialise,
  threadRows,
  toggleLike,
  topAnswer as topAnswerFor,
  unblockAuthor,
  visiblePosts,
  visibleStories,
  type CommunityState,
  type Draft,
  type ReplyDraft,
  type Result,
  type ThreadRow,
} from './store';

/**
 * Holds one `CommunityState` and does the four things that are not the feed
 * itself: reads the phone's copy back, writes it out, tracks whether there is a
 * network, and keeps a clock so "2h" becomes "3h" while the screen is open.
 *
 * It lives above the screen rather than inside it for a reason a farmer would
 * notice: switching to the mandi rates and back must not throw away a
 * half-written reply. The draft is part of the state, so it survives the unmount.
 */

export type Status = 'loading' | 'ready' | 'error';

type CommunityValue = {
  status: Status;
  /** Storage could not be read at all — the one failure the feed cannot absorb. */
  retry: () => void;
  online: boolean;
  now: number;
  /** The feed under the current filter, with blocked authors removed. */
  posts: Post[];
  /** What the current filter is hiding because of a block, so it can be undone. */
  hidden: Array<{ author: AuthorId; count: number }>;
  /** Every author this farmer has blocked, whether or not they have posts here. */
  blocked: AuthorId[];
  stories: Story[];
  filter: FilterId;
  setFilter: (filter: FilterId) => void;
  openPost: Post | undefined;
  openComments: Comment[];
  rows: ThreadRow[];
  openThread: (postId: string) => void;
  closeThread: () => void;
  draft: Draft;
  replyDraft: ReplyDraft;
  updateDraft: (patch: Partial<Draft>) => void;
  updateReply: (patch: Partial<ReplyDraft>) => void;
  publish: () => Result;
  reply: () => Result;
  publishStory: () => Result;
  /** The story on screen, if the viewer is open. */
  viewingStoryId: string | null;
  openStory: (storyId: string) => void;
  closeStory: () => void;
  like: (postId: string) => void;
  remove: (postId: string, commentId?: string) => void;
  report: (postId: string, commentId: string | null, reason: ReportReasonId) => void;
  block: (author: AuthorId) => void;
  unblock: (author: AuthorId) => void;
  seeStory: (storyId: string) => void;
  replyCount: (postId: string) => number;
  topAnswer: (postId: string) => Comment | undefined;
  expertAnswered: (postId: string) => boolean;
  commenters: (postId: string) => AuthorId[];
  /** True while anything written offline is still waiting to be shared. */
  hasPending: boolean;
};

const CommunityContext = createContext<CommunityValue | null>(null);

/** How often the relative times are recomputed, so a post does not stay "4m" for an hour. */
const TICK_MS = 30_000;

export function CommunityProvider({ children }: { children: ReactNode }) {
  const { account } = useSession();
  /*
   * A post a farmer wrote while signed out belongs to that farmer, so the feed
   * migrates to the account on sign-in rather than splitting in two.
   */
  const ownerId = useMemo(() => ownerFor(account?.id ?? null), [account?.id]);
  const document = usePersistentDocument<CommunityState>({
    collection: 'community',
    ownerId,
    seed: () => createState(Date.now()),
    hydrate,
    serialise,
  });
  const { data: state, setData: setState } = document;
  const online = useOnline();
  const [now, setNow] = useState(() => Date.now());

  /*
   * The feed's three states, mapped from the document's. `loading` is now about
   * the backend rather than a staged delay: the phone's copy is already on screen
   * by then, so the spinner only ever appears on a first run with a slow backend.
   */
  const status: Status = document.status === 'loading'
    ? 'loading'
    : document.status === 'error'
      ? 'error'
      : 'ready';

  /*
   * Being offline is a state this feature is built around, not an error: the post
   * goes to the phone and is marked as waiting. Coming back online drains the
   * queue, so every "Waiting to send" row stops waiting at the same moment.
   */
  useEffect(() => {
    if (online) setState((current) => flushPending(current));
  }, [online, setState]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const value = useMemo<CommunityValue>(
    () => ({
      status,
      retry: document.reload,
      online,
      now,
      posts: visiblePosts(state),
      hidden: hiddenByBlock(state),
      blocked: state.blocked,
      stories: visibleStories(state, now),
      filter: state.filter,
      setFilter: (filter) => setState((current) => ({ ...current, filter })),
      openPost: postById(state, state.openPostId),
      openComments: state.openPostId ? (state.comments[state.openPostId] ?? []) : [],
      rows: state.openPostId ? threadRows(state.comments[state.openPostId] ?? []) : [],
      /*
       * Opening a thread normally starts with an empty box — but *re*-opening the
       * same one keeps whatever was half-written in it. That is the whole reason the
       * draft is in the store: closing the thread to go and read the mandi rates is
       * not the same as deciding not to answer.
       */
      openThread: (postId) =>
        setState((current) =>
          current.replyDraft.postId === postId
            ? { ...current, openPostId: postId }
            : {
                ...current,
                openPostId: postId,
                replyDraft: { postId, parentId: null, text: '', attachment: null },
              },
        ),
      closeThread: () => setState((current) => ({ ...current, openPostId: null })),
      draft: state.draft,
      replyDraft: state.replyDraft,
      updateDraft: (patch) =>
        setState((current) => ({ ...current, draft: { ...current.draft, ...patch } })),
      updateReply: (patch) =>
        setState((current) => ({ ...current, replyDraft: { ...current.replyDraft, ...patch } })),
      publish: () => {
        const { state: next, result } = addPost(state, Date.now(), online);
        setState(next);
        return result;
      },
      reply: () => {
        const postId = state.openPostId ?? state.replyDraft.postId;
        if (!postId) return { ok: false, error: 'community.error.empty' };
        const { state: next, result } = addComment(state, postId, Date.now(), online);
        setState(next);
        return result;
      },
      publishStory: () => {
        const { state: next, result } = addStory(state, Date.now());
        setState(next);
        return result;
      },
      viewingStoryId: state.viewingStoryId,
      openStory: (storyId) => setState((current) => openStoryIn(current, storyId)),
      closeStory: () => setState((current) => closeStoryIn(current)),
      like: (postId) => setState((current) => toggleLike(current, postId)),
      remove: (postId, commentId) => setState((current) => removeEntry(current, postId, commentId)),
      report: (postId, commentId, reason) =>
        setState((current) => markReported(current, postId, commentId, reason)),
      block: (author) => setState((current) => blockAuthor(current, author)),
      unblock: (author) => setState((current) => unblockAuthor(current, author)),
      seeStory: (storyId) => setState((current) => seeStoryFor(current, storyId)),
      replyCount: (postId) => replyCountFor(state, postId),
      topAnswer: (postId) => topAnswerFor(state, postId),
      expertAnswered: (postId) => expertAnsweredFor(state, postId),
      commenters: (postId) => commenters(state, postId),
      hasPending: hasPending(state),
    }),
    [state, status, online, now, document.reload],
  );

  return <CommunityContext.Provider value={value}>{children}</CommunityContext.Provider>;
}

export function useCommunity() {
  const context = useContext(CommunityContext);
  if (!context) {
    throw new Error('useCommunity must be used inside a CommunityProvider');
  }
  return context;
}
