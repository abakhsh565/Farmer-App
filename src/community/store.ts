import {
  AUTHORS,
  createSeed,
  createSeedComments,
  isExpert,
  ME,
  STORY_LIFETIME_MS,
  type Attachment,
  type AuthorId,
  type Body,
  type Comment,
  type PlaceId,
  type Post,
  type PostKind,
  type Story,
  type TopicId,
  FILTERS,
  type FilterId,
} from '@/data/community';
import {
  COMMENT_MAX,
  POST_MAX,
  STORY_MAX,
  type ReportReasonId,
} from '@/data/community-rules';
import type { MessageKey } from '@/i18n/catalog';
import { checkEntry } from './validate';

/**
 * The feed's state, and every way it can change.
 *
 * This is a plain data structure with pure functions over it — no React, no
 * storage, no clock. `CommunityProvider` is the thin layer that holds one of
 * these in `useState`, writes it to the phone and reads it back. The split is
 * what makes the interesting behaviour testable: the moderation rules, the
 * thread shape, the offline queue and the recovery from a corrupt payload are all
 * reachable from a test without rendering anything.
 *
 * The one thing it does *not* own is what a post looks like. That is
 * `CommunityScreen`'s job.
 */

export type Draft = {
  text: string;
  kind: PostKind;
  topics: TopicId[];
  place: PlaceId;
  attachment: Attachment | null;
};

export type ReplyDraft = {
  postId: string | null;
  /** The reply being answered, when this is a reply to a reply. */
  parentId: string | null;
  text: string;
  /** A reply carries a photo or a voice note for the same reason a post does. */
  attachment: Attachment | null;
};

export type CommunityState = {
  posts: Post[];
  /** Replies, keyed by the post they hang under. */
  comments: Record<string, Comment[]>;
  stories: Story[];
  /** Authors this farmer has blocked. Their posts stop appearing in the feed. */
  blocked: AuthorId[];
  filter: FilterId;
  /** The post whose thread is open, if any. */
  openPostId: string | null;
  /** The story being watched, if any. Seeing one is what marks it seen. */
  viewingStoryId: string | null;
  draft: Draft;
  replyDraft: ReplyDraft;
};

export const emptyDraft = (): Draft => ({
  text: '',
  kind: 'question',
  topics: ['cotton'],
  place: 'wazirabad',
  attachment: null,
});

export function createState(now: number): CommunityState {
  const { posts, stories } = createSeed(now);
  return {
    posts,
    comments: createSeedComments(now),
    stories,
    blocked: [],
    filter: 'all',
    openPostId: null,
    viewingStoryId: null,
    draft: emptyDraft(),
    replyDraft: { postId: null, parentId: null, text: '', attachment: null },
  };
}

/** The longest a draft may be, per kind of thing being written. */
export function maxLengthFor(target: 'post' | 'comment' | 'story'): number {
  if (target === 'post') return POST_MAX;
  if (target === 'comment') return COMMENT_MAX;
  return STORY_MAX;
}

export type Result = { ok: true; id: string } | { ok: false; error: MessageKey };

// ── selection ───────────────────────────────────────────────────────────────

const newestFirst = (a: { createdAt: number }, b: { createdAt: number }) => b.createdAt - a.createdAt;

export function isBlocked(state: CommunityState, author: AuthorId): boolean {
  return state.blocked.includes(author);
}

/**
 * Whether a post is in the current filter. An unknown filter lets everything
 * through rather than emptying the feed: a chip that was renamed away should not
 * look like a village with nothing to say.
 */
export function matchesFilter(id: FilterId, post: Post): boolean {
  const filter = FILTERS.find((entry) => entry.id === id);
  return filter ? filter.match(post) : true;
}

/**
 * The feed: this filter, nothing from an author the farmer blocked.
 *
 * Removed posts are *not* filtered out here, and that is deliberate: the only
 * removed posts still in the list are the tombstones — a post that was answered
 * and then deleted — and a tombstone has to stay visible. Hiding it would take the
 * replies down with it, which is the defect the tombstone exists to prevent.
 */
export function visiblePosts(state: CommunityState): Post[] {
  return state.posts
    .filter((post) => matchesFilter(state.filter, post) && !isBlocked(state, post.author))
    .sort(newestFirst);
}

export function postById(state: CommunityState, id: string | null): Post | undefined {
  return id ? state.posts.find((post) => post.id === id) : undefined;
}

export function commentsFor(state: CommunityState, postId: string): Comment[] {
  return state.comments[postId] ?? [];
}

export function replyCount(state: CommunityState, postId: string): number {
  return commentsFor(state, postId).length;
}

/**
 * The replies worth showing on the card: the expert's, but only when she opened
 * the thread, and never twice — a card that quotes her answer and then announces
 * "Expert answered" underneath has said the same thing in two ways.
 */
export function topAnswer(state: CommunityState, postId: string): Comment | undefined {
  const [first] = commentsFor(state, postId);
  return first && isExpert(first.author) ? first : undefined;
}

export function expertAnswered(state: CommunityState, postId: string): boolean {
  if (topAnswer(state, postId)) return false;
  return commentsFor(state, postId).some((comment) => isExpert(comment.author));
}

/** Who answered, in order and once each — the faces on the card. */
export function commenters(state: CommunityState, postId: string): AuthorId[] {
  const seen: AuthorId[] = [];
  for (const comment of commentsFor(state, postId)) {
    if (!seen.includes(comment.author)) seen.push(comment.author);
  }
  return seen;
}

export type ThreadRow = { comment: Comment; depth: number };

/**
 * The thread as a list to render: a parent, then its replies, then the next
 * parent. Depth stops at two levels of indent — beyond that the text column is
 * too narrow to read, so a deeper reply keeps its place in the conversation and
 * loses the extra indent.
 *
 * A reply whose parent is missing (deleted outright, or written before the parent
 * was) is treated as a top-level reply rather than dropped: the words are still
 * somebody's answer to the question, even if the line it answered is gone.
 */
export function threadRows(comments: readonly Comment[]): ThreadRow[] {
  const byParent = new Map<string | null, Comment[]>();
  const ids = new Set(comments.map((comment) => comment.id));

  for (const comment of comments) {
    const parent = comment.parentId && ids.has(comment.parentId) ? comment.parentId : null;
    const bucket = byParent.get(parent) ?? [];
    bucket.push(comment);
    byParent.set(parent, bucket);
  }

  const rows: ThreadRow[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const comment of (byParent.get(parent) ?? []).sort(
      (a, b) => a.createdAt - b.createdAt,
    )) {
      rows.push({ comment, depth: Math.min(depth, 2) });
      walk(comment.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

/**
 * The rings, in the order they are drawn: the seeded neighbours first and the
 * farmer's own story at the front once they add one. Deliberately *not* sorted by
 * age — a ring row is a row of people, and reordering it every time somebody posts
 * is how a farmer loses the one they were about to tap.
 */
export function visibleStories(state: CommunityState, now: number): Story[] {
  return state.stories.filter((story) => story.expiresAt > now);
}

/** Posts hidden from the feed by a block, per author, so the block is reversible. */
export function hiddenByBlock(
  state: CommunityState,
): Array<{ author: AuthorId; count: number }> {
  return state.blocked
    .map((author) => ({
      author,
      count: state.posts.filter(
        (post) => post.author === author && matchesFilter(state.filter, post),
      ).length,
    }))
    .filter((entry) => entry.count > 0);
}

// ── writing ─────────────────────────────────────────────────────────────────

/** Everything this farmer has written, newest first — what the rate limit counts. */
function myEntries(state: CommunityState): Array<{ body: Body; createdAt: number }> {
  const posts = state.posts
    .filter((post) => post.author === ME)
    .map(({ body, createdAt }) => ({ body, createdAt }));
  const comments = Object.values(state.comments)
    .flat()
    .filter((comment) => comment.author === ME)
    .map(({ body, createdAt }) => ({ body, createdAt }));
  return [...posts, ...comments].sort((a, b) => b.createdAt - a.createdAt);
}

function newId(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${random}`;
}

/**
 * Publish the composer's draft. The check runs against this farmer's own recent
 * entries, so the rules are about them rather than about the feed.
 *
 * `pending` is set when there is no network: the post is saved on the phone and
 * the card says it is waiting, instead of the composer throwing the words away.
 */
export function addPost(
  state: CommunityState,
  now: number,
  online: boolean,
): { state: CommunityState; result: Result } {
  const { draft } = state;
  const text = draft.text.trim();

  const error = checkEntry({ text, max: POST_MAX, mine: myEntries(state), now });
  if (error) return { state, result: { ok: false, error } };

  const post: Post = {
    id: newId('p'),
    author: ME,
    kind: draft.kind,
    topics: draft.topics,
    place: draft.place,
    body: { text },
    createdAt: now,
    attachment: draft.attachment ?? undefined,
    likes: 0,
    likedByMe: false,
    // Absent, not false, when it went out with the post: `pending` marks the
    // exception, and a field that is always there is a field nobody checks.
    pending: online ? undefined : true,
  };

  return {
    state: {
      ...state,
      posts: [post, ...state.posts],
      comments: { ...state.comments, [post.id]: [] },
      draft: emptyDraft(),
    },
    result: { ok: true, id: post.id },
  };
}

export function addComment(
  state: CommunityState,
  postId: string,
  now: number,
  online: boolean,
): { state: CommunityState; result: Result } {
  const { replyDraft, openPostId } = state;
  const target = openPostId ?? postId;
  const text = replyDraft.text.trim();

  const error = checkEntry({ text, max: COMMENT_MAX, mine: myEntries(state), now });
  if (error) return { state, result: { ok: false, error } };

  const comment: Comment = {
    id: newId('c'),
    author: ME,
    parentId: replyDraft.parentId,
    body: { text },
    createdAt: now,
    attachment: replyDraft.attachment ?? undefined,
    pending: online ? undefined : true,
  };

  return {
    state: {
      ...state,
      comments: {
        ...state.comments,
        [target]: [...(state.comments[target] ?? []), comment],
      },
      // The thread stays open; only the box empties, so a farmer answering two
      // people in a row does not have to find the post again.
      replyDraft: { postId: target, parentId: null, text: '', attachment: null },
    },
    result: { ok: true, id: comment.id },
  };
}

/** One tap, one like. A farmer who likes and unlikes twice has not liked it twice. */
export function toggleLike(state: CommunityState, postId: string): CommunityState {
  return {
    ...state,
    posts: state.posts.map((post) =>
      post.id === postId
        ? {
            ...post,
            likedByMe: !post.likedByMe,
            likes: Math.max(0, post.likes + (post.likedByMe ? -1 : 1)),
          }
        : post,
    ),
  };
}

/**
 * Remove a post or a reply.
 *
 * A row with answers under it becomes a tombstone rather than disappearing: the
 * replies were written to it, and a thread that loses its parent mid-conversation
 * is unreadable. A row nobody answered is removed outright, because leaving a
 * row of nothing behind is noise.
 */
export function removeEntry(
  state: CommunityState,
  postId: string,
  commentId?: string,
): CommunityState {
  if (!commentId) {
    const hasReplies = replyCount(state, postId) > 0;
    const posts = hasReplies
      ? state.posts.map((post) =>
          post.id === postId ? { ...post, removed: 'author' as const } : post,
        )
      : state.posts.filter((post) => post.id !== postId);

    const comments = { ...state.comments };
    if (!hasReplies) delete comments[postId];

    return {
      ...state,
      posts,
      comments,
      openPostId: state.openPostId === postId && !hasReplies ? null : state.openPostId,
    };
  }

  const list = commentsFor(state, postId);
  const hasChildren = list.some((comment) => comment.parentId === commentId);

  return {
    ...state,
    comments: {
      ...state.comments,
      [postId]: hasChildren
        ? list.map((comment) =>
            comment.id === commentId ? { ...comment, removed: 'author' as const } : comment,
          )
        : list.filter((comment) => comment.id !== commentId),
    },
  };
}

export function markReported(
  state: CommunityState,
  postId: string,
  commentId: string | null,
  reason: ReportReasonId,
): CommunityState {
  if (!commentId) {
    return {
      ...state,
      posts: state.posts.map((post) => (post.id === postId ? { ...post, reported: reason } : post)),
    };
  }

  return {
    ...state,
    comments: {
      ...state.comments,
      [postId]: commentsFor(state, postId).map((comment) =>
        comment.id === commentId ? { ...comment, reported: reason } : comment,
      ),
    },
  };
}

export function blockAuthor(state: CommunityState, author: AuthorId): CommunityState {
  if (state.blocked.includes(author)) return state;
  return { ...state, blocked: [...state.blocked, author] };
}

export function unblockAuthor(state: CommunityState, author: AuthorId): CommunityState {
  return { ...state, blocked: state.blocked.filter((entry) => entry !== author) };
}

// ── stories ─────────────────────────────────────────────────────────────────

export function openStory(state: CommunityState, id: string): CommunityState {
  return { ...state, viewingStoryId: id };
}

export function closeStory(state: CommunityState): CommunityState {
  return { ...state, viewingStoryId: null };
}

export function seeStory(state: CommunityState, id: string): CommunityState {
  return {
    ...state,
    stories: state.stories.map((story) => (story.id === id ? { ...story, seen: true } : story)),
  };
}

export function addStory(
  state: CommunityState,
  now: number,
): { state: CommunityState; result: Result } {
  const text = state.draft.text.trim();
  const error = checkEntry({ text, max: STORY_MAX, mine: myEntries(state), now });
  if (error) return { state, result: { ok: false, error } };

  const story: Story = {
    id: newId('s'),
    author: ME,
    body: { text },
    createdAt: now,
    expiresAt: now + STORY_LIFETIME_MS,
    attachment: state.draft.attachment ?? undefined,
    seen: true,
  };

  // Newest first, and the farmer's own ring goes to the front where they will
  // look for it.
  return {
    state: { ...state, stories: [story, ...state.stories], draft: emptyDraft() },
    result: { ok: true, id: story.id },
  };
}

/** Drop what has expired. Called on hydration and whenever the feed is opened. */
export function expireStories(state: CommunityState, now: number): CommunityState {
  const stories = state.stories.filter((story) => story.expiresAt > now);
  return stories.length === state.stories.length ? state : { ...state, stories };
}

/**
 * The queue draining: everything written offline stops being pending the moment
 * there is a network again. There is no server in this build, so "shared" means
 * "no longer marked as waiting" — which is the part of the behaviour the UI and
 * the tests can hold to.
 */
export function flushPending(state: CommunityState): CommunityState {
  const clearEntry = <T extends { pending?: boolean }>(entry: T): T =>
    entry.pending ? { ...entry, pending: false } : entry;

  const posts = state.posts.map(clearEntry);
  const comments = Object.fromEntries(
    Object.entries(state.comments).map(([postId, list]) => [postId, list.map(clearEntry)]),
  );

  return { ...state, posts, comments };
}

export function hasPending(state: CommunityState): boolean {
  return (
    state.posts.some((post) => post.pending) ||
    Object.values(state.comments).some((list) => list.some((comment) => comment.pending))
  );
}

// ── what survives a reload ──────────────────────────────────────────────────

export const STORAGE_VERSION = 1;

/**
 * What is written to the phone: what the farmer wrote, and what they decided.
 * The open thread, the filter and the drafts are session state — a half-written
 * question is not something to find on the phone three days later.
 */
type Persisted = {
  version: number;
  posts: Post[];
  comments: Record<string, Comment[]>;
  stories: Story[];
  blocked: AuthorId[];
};

export function serialise(state: CommunityState): string {
  const payload: Persisted = {
    version: STORAGE_VERSION,
    posts: state.posts,
    comments: state.comments,
    stories: state.stories,
    blocked: state.blocked,
  };
  return JSON.stringify(payload);
}

function reviveBody(value: unknown): Body | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as { key?: unknown; text?: unknown };
  if (typeof body.text === 'string' && body.text.trim()) return { text: body.text };
  if (typeof body.key === 'string') return { key: body.key as MessageKey };
  return null;
}

function reviveAttachment(value: unknown): Attachment | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const attachment = value as Partial<Attachment>;
  if (attachment.kind !== 'image' && attachment.kind !== 'video' && attachment.kind !== 'voice') {
    return undefined;
  }
  /*
   * A `blob:` URL belongs to the page that made it. After a reload the file is
   * gone — so the URL is dropped, and the card says the attachment is not on this
   * phone instead of drawing a broken image the farmer cannot explain.
   */
  const url = typeof attachment.url === 'string' && !attachment.url.startsWith('blob:')
    ? attachment.url
    : '';

  return {
    kind: attachment.kind,
    url,
    placeholder: attachment.placeholder === true,
    name: typeof attachment.name === 'string' ? attachment.name : undefined,
    durationMs: typeof attachment.durationMs === 'number' ? attachment.durationMs : undefined,
  };
}

function isAuthorId(value: unknown): value is AuthorId {
  return typeof value === 'string' && value in AUTHORS;
}

function reviveEntry(value: unknown): (Omit<Comment, 'parentId'> & { parentId?: unknown }) | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  const body = reviveBody(entry.body);

  if (typeof entry.id !== 'string' || !isAuthorId(entry.author) || !body) return null;
  if (typeof entry.createdAt !== 'number') return null;
  if (entry.removed !== undefined && entry.removed !== 'author' && entry.removed !== 'moderation') {
    return null;
  }

  return {
    id: entry.id,
    author: entry.author,
    body,
    createdAt: entry.createdAt,
    attachment: reviveAttachment(entry.attachment),
    removed: entry.removed as Comment['removed'],
    reported: typeof entry.reported === 'string' ? (entry.reported as ReportReasonId) : undefined,
    pending: entry.pending === true,
    parentId: entry.parentId,
  };
}

function revivePost(value: unknown): Post | null {
  const entry = reviveEntry(value);
  if (!entry) return null;
  const raw = value as Record<string, unknown>;

  const kind = raw.kind === 'question' || raw.kind === 'update' ? raw.kind : null;
  const topics = Array.isArray(raw.topics) ? (raw.topics.filter(isTopic) as TopicId[]) : null;
  const place = typeof raw.place === 'string' ? (raw.place as PlaceId) : null;

  if (!kind || !topics || !place || typeof raw.likes !== 'number') return null;

  const { parentId: _parentId, ...rest } = entry;
  return {
    ...rest,
    kind,
    topics,
    place,
    likes: raw.likes,
    likedByMe: raw.likedByMe === true,
  };
}

function isTopic(value: unknown): boolean {
  return (
    value === 'cotton' ||
    value === 'wheat' ||
    value === 'maize' ||
    value === 'rice' ||
    value === 'pest' ||
    value === 'water' ||
    value === 'market'
  );
}

function reviveComment(value: unknown): Comment | null {
  const entry = reviveEntry(value);
  if (!entry) return null;
  const parentId = typeof entry.parentId === 'string' ? entry.parentId : null;
  const { parentId: _parentId, ...rest } = entry;
  return { ...rest, parentId };
}

function reviveStory(value: unknown): Story | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const body = reviveBody(raw.body);

  if (
    typeof raw.id !== 'string' ||
    !isAuthorId(raw.author) ||
    !body ||
    typeof raw.createdAt !== 'number' ||
    typeof raw.expiresAt !== 'number'
  ) {
    return null;
  }

  return {
    id: raw.id,
    author: raw.author,
    body,
    createdAt: raw.createdAt,
    expiresAt: raw.expiresAt,
    attachment: reviveAttachment(raw.attachment),
    seen: raw.seen === true,
  };
}

/**
 * Read the phone's copy back.
 *
 * Strict on purpose: anything that does not fully parse returns null and the feed
 * is rebuilt from the seed, because half a feed — a post whose replies were
 * dropped, a comment with no author — is worse than a known-good one, and the
 * farmer has no way to tell which half is missing. Expired stories are the one
 * thing dropped without complaint: that is what expiring means.
 */
export function hydrate(raw: string | null, now: number): CommunityState | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const payload = parsed as Partial<Persisted>;
  if (payload.version !== STORAGE_VERSION) return null;
  if (!Array.isArray(payload.posts) || !Array.isArray(payload.stories)) return null;
  if (payload.comments && typeof payload.comments !== 'object') return null;

  const posts = payload.posts.map(revivePost);
  if (posts.some((post) => post === null)) return null;

  const stories = payload.stories.map(reviveStory);
  if (stories.some((story) => story === null)) return null;

  const comments: Record<string, Comment[]> = {};
  for (const [postId, list] of Object.entries(payload.comments ?? {})) {
    if (!Array.isArray(list)) return null;
    const revived = list.map(reviveComment);
    if (revived.some((comment) => comment === null)) return null;
    comments[postId] = revived as Comment[];
  }

  const blocked = Array.isArray(payload.blocked) ? payload.blocked.filter(isAuthorId) : [];

  const base = createState(now);
  return expireStories(
    {
      ...base,
      posts: posts as Post[],
      comments,
      stories: stories as Story[],
      blocked,
    },
    now,
  );
}
