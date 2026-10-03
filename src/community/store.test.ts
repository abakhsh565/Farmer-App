import { describe, expect, it } from 'vitest';
import { STORY_LIFETIME_MS, type Attachment, type Comment } from '@/data/community';
import { POST_MAX } from '@/data/community-rules';
import {
  addComment,
  addPost,
  addStory,
  blockAuthor,
  commenters,
  createState,
  expertAnswered,
  expireStories,
  flushPending,
  hasPending,
  hiddenByBlock,
  hydrate,
  removeEntry,
  replyCount,
  seeStory,
  serialise,
  threadRows,
  toggleLike,
  topAnswer,
  unblockAuthor,
  visiblePosts,
  visibleStories,
  type CommunityState,
} from './store';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

const seed = () => createState(NOW);

/** The composer's draft, set the way the composer sets it. */
const withDraft = (
  state: CommunityState,
  text: string,
  attachment: Attachment | null = null,
): CommunityState => ({
  ...state,
  draft: { ...state.draft, text, attachment },
});

const withReply = (state: CommunityState, text: string, parentId: string | null = null) => ({
  ...state,
  replyDraft: { ...state.replyDraft, text, parentId },
});

describe('the seeded feed', () => {
  it('opens with three posts and the design\u2019s own numbers behind them', () => {
    const state = seed();

    expect(state.posts.map((post) => post.id)).toEqual(['p1', 'p2', 'p3']);
    // The numbers in the mockup are counts here, not captions.
    expect(replyCount(state, 'p1')).toBe(12);
    expect(replyCount(state, 'p2')).toBe(8);
    expect(replyCount(state, 'p3')).toBe(6);
    expect(state.posts.find((post) => post.id === 'p3')?.likes).toBe(24);
  });

  it('quotes the expert only when she opened the thread', () => {
    const state = seed();

    // p2: Dr. Amna's answer is the first reply, so the card quotes it.
    expect(topAnswer(state, 'p2')?.id).toBe('c2.1');
    // p1: she answered sixth, so the card says "Expert answered" instead.
    expect(topAnswer(state, 'p1')).toBeUndefined();
    expect(expertAnswered(state, 'p1')).toBe(true);
    // Saying both would be saying it twice.
    expect(expertAnswered(state, 'p2')).toBe(false);
    // p3 has no expert in it at all.
    expect(expertAnswered(state, 'p3')).toBe(false);
  });

  it('names the people who actually answered, in order and once each', () => {
    expect(commenters(seed(), 'p1')).toEqual(['rafiq', 'sajid', 'akram', 'nadeem', 'amna', 'shazia']);
  });
});

describe('the feed under a filter', () => {
  it('shows everything, then only questions, then only cotton', () => {
    const state = seed();

    expect(visiblePosts({ ...state, filter: 'all' })).toHaveLength(3);
    expect(visiblePosts({ ...state, filter: 'questions' })).toHaveLength(2);
    // Every seeded post is a cotton post — this is a cotton village.
    expect(visiblePosts({ ...state, filter: 'cotton' })).toHaveLength(3);
  });

  it('lets an unknown filter through rather than emptying the village', () => {
    const state = { ...seed(), filter: 'rice' as never };
    expect(visiblePosts(state)).toHaveLength(3);
  });
});

describe('threads', () => {
  it('nests replies under the reply they answer and caps the indent', () => {
    const rows = threadRows([
      { id: 'a', author: 'sajid', body: { text: 'a' }, createdAt: 1, parentId: null },
      { id: 'b', author: 'rafiq', body: { text: 'b' }, createdAt: 2, parentId: 'a' },
      { id: 'c', author: 'akram', body: { text: 'c' }, createdAt: 3, parentId: 'b' },
      { id: 'd', author: 'amna', body: { text: 'd' }, createdAt: 4, parentId: 'c' },
    ]);

    expect(rows.map((row) => [row.comment.id, row.depth])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
      // One deeper keeps its place in the conversation and loses the indent.
      ['d', 2],
    ]);
  });

  it('keeps a reply whose parent is gone rather than dropping what somebody said', () => {
    const rows = threadRows([
      { id: 'orphan', author: 'sajid', body: { text: 'alone' }, createdAt: 1, parentId: 'gone' },
    ]);

    expect(rows.map((row) => [row.comment.id, row.depth])).toEqual([['orphan', 0]]);
  });
});

describe('writing', () => {
  it('publishes a post, empties the box and puts it at the top', () => {
    const { state, result } = addPost(withDraft(seed(), 'Kya kapas ab bechni chahiye?'), NOW, true);

    expect(result.ok).toBe(true);
    expect(state.posts[0]?.body).toEqual({ text: 'Kya kapas ab bechni chahiye?' });
    expect(state.draft.text).toBe('');
    expect(state.posts[0]?.pending).toBeUndefined();
  });

  it('saves a post written offline and marks it as waiting', () => {
    const { state } = addPost(withDraft(seed(), 'Sawan ka pani ruk gya hai'), NOW, false);

    expect(state.posts[0]?.pending).toBe(true);
    expect(hasPending(state)).toBe(true);

    // Coming back on drains the queue.
    const online = flushPending(state);
    expect(online.posts[0]?.pending).toBe(false);
    expect(hasPending(online)).toBe(false);
  });

  it('refuses a post it should refuse, and changes nothing when it does', () => {
    // The fresh draft is empty, which is the case being refused.
    const state = seed();
    const { state: next, result } = addPost(state, NOW, true);

    expect(result).toEqual({ ok: false, error: 'community.error.empty' });
    // The rejected text is still in the box: it is the farmer's, not ours.
    expect(next).toBe(state);
  });

  it('answers in the thread, and leaves the box ready for the next person', () => {
    const opened = { ...seed(), openPostId: 'p1' };
    const { state, result } = addComment(withReply(opened, 'Do din ruk jayen'), 'p1', NOW, true);

    expect(result.ok).toBe(true);
    expect(replyCount(state, 'p1')).toBe(13);
    expect(state.comments.p1?.at(-1)?.body).toEqual({ text: 'Do din ruk jayen' });
    expect(state.replyDraft.text).toBe('');
    // The thread stays open — a farmer may be answering two people in a row.
    expect(state.openPostId).toBe('p1');
    expect(state.replyDraft.parentId).toBeNull();
  });

  it('attaches a reply to the reply it answers', () => {
    const opened = { ...seed(), openPostId: 'p1' };
    const { state } = addComment(withReply(opened, 'ji', 'c1.6'), 'p1', NOW, true);

    expect(state.comments.p1?.at(-1)?.parentId).toBe('c1.6');
  });
});

describe('likes', () => {
  it('counts one tap as one like, whichever way it is tapped', () => {
    const state = seed();

    const liked = toggleLike(state, 'p3');
    expect(liked.posts.find((post) => post.id === 'p3')).toMatchObject({
      likes: 25,
      likedByMe: true,
    });

    const undone = toggleLike(liked, 'p3');
    expect(undone.posts.find((post) => post.id === 'p3')).toMatchObject({
      likes: 24,
      likedByMe: false,
    });
  });
});

describe('removing', () => {
  it('leaves a tombstone when a post has answers under it', () => {
    const state = removeEntry(seed(), 'p3');

    const post = state.posts.find((entry) => entry.id === 'p3');
    expect(post?.removed).toBe('author');
    // The replies were written to it, so they stay — and so does the row itself,
    // or the thread would vanish with them.
    expect(replyCount(state, 'p3')).toBe(6);
    expect(visiblePosts(state).map((entry) => entry.id)).toEqual(['p1', 'p2', 'p3']);
  });

  it('removes a post outright when nobody answered it', () => {
    const { state: posted } = addPost(withDraft(seed(), 'Koi jawab?'), NOW, true);
    const id = posted.posts[0]!.id;

    const state = removeEntry(posted, id);
    expect(state.posts.find((post) => post.id === id)).toBeUndefined();
    expect(state.comments[id]).toBeUndefined();
  });

  it('closes the thread only when the post is really gone', () => {
    const tombstoned = removeEntry({ ...seed(), openPostId: 'p3' }, 'p3');
    expect(tombstoned.openPostId).toBe('p3');

    const { state: posted } = addPost(withDraft(seed(), 'Akela'), NOW, true);
    const id = posted.posts[0]!.id;
    const gone = removeEntry({ ...posted, openPostId: id }, id);
    expect(gone.openPostId).toBeNull();
  });

  it('keeps a removed reply in place when other replies answer it', () => {
    const state = removeEntry(seed(), 'p1', 'c1.6');

    const removed = state.comments.p1?.find((comment: Comment) => comment.id === 'c1.6');
    expect(removed?.removed).toBe('author');
    expect(state.comments.p1).toHaveLength(12);
  });

  it('drops a reply nobody answered', () => {
    const state = removeEntry(seed(), 'p1', 'c1.9');

    expect(state.comments.p1?.some((comment) => comment.id === 'c1.9')).toBe(false);
    expect(replyCount(state, 'p1')).toBe(11);
  });
});

describe('blocking', () => {
  it('hides an author, says what it hid, and undoes cleanly', () => {
    const blocked = blockAuthor(seed(), 'sajid');

    expect(visiblePosts(blocked).map((post) => post.id)).toEqual(['p2', 'p3']);
    expect(hiddenByBlock(blocked)).toEqual([{ author: 'sajid', count: 1 }]);

    const undone = unblockAuthor(blocked, 'sajid');
    expect(visiblePosts(undone)).toHaveLength(3);
    expect(hiddenByBlock(undone)).toEqual([]);
  });

  it('does not count the same author twice', () => {
    const twice = blockAuthor(blockAuthor(seed(), 'sajid'), 'sajid');
    expect(twice.blocked).toEqual(['sajid']);
  });
});

describe('stories', () => {
  it('keeps the seeded order and drops what has expired', () => {
    const state = seed();

    // Sajid, Rafiq, Dr. Amna — the design's order, not sorted by age.
    expect(visibleStories(state, NOW).map((story) => story.author)).toEqual([
      'sajid',
      'rafiq',
      'amna',
    ]);

    expect(visibleStories(state, NOW + STORY_LIFETIME_MS + HOUR)).toHaveLength(0);
    expect(expireStories(state, NOW + STORY_LIFETIME_MS + HOUR).stories).toHaveLength(0);
  });

  it('marks a story seen when it is watched', () => {
    const state = seeStory(seed(), 's1');
    expect(state.stories.find((story) => story.id === 's1')?.seen).toBe(true);
  });

  it('puts the farmer\u2019s own story first, already seen', () => {
    const { state, result } = addStory(withDraft(seed(), 'Aaj mandi gaye'), NOW);

    expect(result.ok).toBe(true);
    expect(state.stories[0]).toMatchObject({ author: 'me', seen: true });
    expect(state.stories[0]?.expiresAt).toBe(NOW + STORY_LIFETIME_MS);
    expect(state.draft.text).toBe('');
  });

  it('holds a story to the story limit, not the post limit', () => {
    const { result } = addStory(withDraft(seed(), 'a'.repeat(POST_MAX)), NOW);
    expect(result).toEqual({ ok: false, error: 'community.error.long' });
  });
});

describe('what survives a reload', () => {
  it('comes back the way it went in', () => {
    const state = seeStory(toggleLike(blockAuthor(seed(), 'nadeem'), 'p3'), 's1');
    const restored = hydrate(serialise(state), NOW);

    expect(restored).not.toBeNull();
    expect(restored?.posts.map((post) => post.id)).toEqual(['p1', 'p2', 'p3']);
    expect(restored?.posts.find((post) => post.id === 'p3')).toMatchObject({
      likes: 25,
      likedByMe: true,
    });
    expect(restored?.blocked).toEqual(['nadeem']);
    expect(restored?.stories.find((story) => story.id === 's1')?.seen).toBe(true);
    expect(replyCount(restored as CommunityState, 'p1')).toBe(12);
  });

  it('forgets an attachment whose file died with the page', () => {
    const { state } = addPost(
      withDraft(seed(), 'Patta dekhen', { kind: 'image', url: 'blob:http://localhost/1' }),
      NOW,
      true,
    );

    const restored = hydrate(serialise(state), NOW);
    // The row survives; the URL does not, and the card will say so.
    expect(restored?.posts[0]?.attachment).toEqual({ kind: 'image', url: '', placeholder: false });
  });

  it('drops expired stories without complaining about them', () => {
    const state = seed();
    const later = hydrate(serialise(state), NOW + STORY_LIFETIME_MS + HOUR);

    expect(later?.stories).toHaveLength(0);
    expect(later?.posts).toHaveLength(3);
  });

  /** Half a feed is worse than a known-good one, so anything unreadable is refused whole. */
  it.each([
    ['nothing stored', null],
    ['a payload that is not JSON', 'not json at all'],
    ['a payload from another version', '{"version":99,"posts":[],"stories":[]}'],
    ['posts that are not a list', '{"version":1,"posts":{},"stories":[]}'],
    ['a post with no author we know', '{"version":1,"posts":[{"id":"x","body":{"text":"hi"},"createdAt":1,"kind":"question","topics":[],"place":"wazirabad","likes":0}],"stories":[]}'],
    ['a post with no text at all', '{"version":1,"posts":[{"id":"x","author":"me","body":{},"createdAt":1,"kind":"question","topics":[],"place":"wazirabad","likes":0}],"stories":[]}'],
  ])('refuses %s', (_label, raw) => {
    expect(hydrate(raw, NOW)).toBeNull();
  });
});
