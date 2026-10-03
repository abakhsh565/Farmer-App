import type { MessageKey } from '@/i18n/catalog';
import type { ReportReasonId } from './community-rules';

/**
 * The Community feed's shape and its seeded content.
 *
 * Two rules govern what is in here, and they are the same two the chat screen
 * follows:
 *
 *   · **Names, places, crops and text are message keys, never finished strings.**
 *     A post seeded with the English words baked in is a post that stays English
 *     after the farmer switches to Urdu — and this feed is the screen where a
 *     farmer is most likely to be reading Urdu.
 *   · **Numbers are counted, not drawn.** `12 replies` is twelve comment rows in
 *     this file; the expert badge is derived from who actually answered; the like
 *     count is state that changes when someone taps it. A number typed into a
 *     component is a number that is wrong the moment the thing it counts changes,
 *     which is exactly the defect the chat list had.
 *
 * Times are offsets from a caller-supplied `now` rather than absolute timestamps,
 * so the seeded feed is two hours old whenever the app is opened, and so a test
 * can pin it.
 */

// ── people ──────────────────────────────────────────────────────────────────

export type AuthorId = 'me' | 'sajid' | 'rafiq' | 'amna' | 'akram' | 'shazia' | 'nadeem';

export type Author = {
  nameKey: MessageKey;
  /** Avatar hue, taken from the system palette. */
  tint: string;
  /** The one author whose answers the product vouches for, everywhere they appear. */
  expert?: boolean;
};

export const AUTHORS: Record<AuthorId, Author> = {
  me: { nameKey: 'farmer.name', tint: 'bg-brand' },
  sajid: { nameKey: 'community.author1', tint: 'bg-blue-500' },
  rafiq: { nameKey: 'community.author2', tint: 'bg-amber-600' },
  amna: { nameKey: 'community.author.amna', tint: 'bg-violet-500', expert: true },
  akram: { nameKey: 'community.author.akram', tint: 'bg-green-600' },
  shazia: { nameKey: 'community.author.shazia', tint: 'bg-red-500' },
  nadeem: { nameKey: 'community.author.nadeem', tint: 'bg-clay-500' },
};

/** The farmer using the app. `me` is compared by id, never by name. */
export const ME: AuthorId = 'me';

export function isExpert(author: AuthorId): boolean {
  return AUTHORS[author].expert === true;
}

// ── what a post is about ────────────────────────────────────────────────────

export type TopicId = 'cotton' | 'wheat' | 'maize' | 'rice' | 'pest' | 'water' | 'market';

/** Crop topics are the crops' own names — one vocabulary, not two. */
export const TOPICS: ReadonlyArray<{ id: TopicId; labelKey: MessageKey }> = [
  { id: 'cotton', labelKey: 'crop.cotton' },
  { id: 'wheat', labelKey: 'crop.wheat' },
  { id: 'pest', labelKey: 'community.topic.pest' },
  { id: 'water', labelKey: 'community.topic.water' },
  { id: 'market', labelKey: 'community.topic.market' },
];

export type PlaceId = 'wazirabad' | 'gujranwala' | 'sialkot';

export const PLACES: ReadonlyArray<{ id: PlaceId; labelKey: MessageKey }> = [
  { id: 'wazirabad', labelKey: 'community.place.wazirabad' },
  { id: 'gujranwala', labelKey: 'community.place.gujranwala' },
  { id: 'sialkot', labelKey: 'community.place.sialkot' },
];

export type PostKind = 'question' | 'update';

export const KINDS: ReadonlyArray<{ id: PostKind; labelKey: MessageKey }> = [
  { id: 'question', labelKey: 'community.kind.question' },
  { id: 'update', labelKey: 'community.kind.update' },
];

/**
 * The filter chips, each with the rule it applies. The chip row and its meaning
 * live together so adding a chip is adding one row here — the screen renders
 * whatever is in this array.
 */
export type FilterId = 'all' | 'questions' | 'cotton';

export const FILTERS: ReadonlyArray<{
  id: FilterId;
  labelKey: MessageKey;
  match: (post: Post) => boolean;
}> = [
  { id: 'all', labelKey: 'community.filter.all', match: () => true },
  {
    id: 'questions',
    labelKey: 'community.filter.questions',
    match: (post) => post.kind === 'question',
  },
  {
    id: 'cotton',
    labelKey: 'crop.cotton',
    match: (post) => post.topics.includes('cotton'),
  },
];

// ── the shape of a post ─────────────────────────────────────────────────────

export type Attachment = {
  kind: 'image' | 'video' | 'voice';
  /**
   * A `blob:` object URL for anything attached on this phone. It lives in memory
   * and dies with the page, so `url === ''` means the file is gone — which the
   * card says out loud rather than showing a broken box.
   */
  url: string;
  /**
   * True for the seeded design content, which has a picture in the mockup and no
   * file behind it here. The card draws the mockup's stand-in for it, so an
   * honest placeholder is never confused with a lost attachment.
   */
  placeholder?: boolean;
  name?: string;
  /** Voice messages only. */
  durationMs?: number;
};

/** Text is either a catalog key (seeded, and so translatable) or the farmer's words. */
export type Body = { key: MessageKey } | { text: string };

export function bodyText(body: Body, t: (key: MessageKey) => string): string {
  return 'key' in body ? t(body.key) : body.text;
}

type Entry = {
  id: string;
  author: AuthorId;
  body: Body;
  createdAt: number;
  attachment?: Attachment;
  /**
   * Removed content keeps its row. A reply whose parent vanished takes the rest of
   * the conversation with it, so the row stays and says it was removed — which is
   * also how a moderation action is supposed to look.
   */
  removed?: 'author' | 'moderation';
  /** Reported by this farmer, and why. Reports are not shown to the author. */
  reported?: ReportReasonId;
  /** Written while offline: saved here, not yet shared. */
  pending?: boolean;
};

export type Comment = Entry & { parentId: string | null };

export type Post = Entry & {
  kind: PostKind;
  topics: TopicId[];
  place: PlaceId;
  likes: number;
  likedByMe: boolean;
};

/** A story is the same thing as a post, with a shelf life. */
export type Story = {
  id: string;
  author: AuthorId;
  body: Body;
  createdAt: number;
  expiresAt: number;
  attachment?: Attachment;
  seen: boolean;
};

export const STORY_LIFETIME_MS = 24 * 60 * 60 * 1000;

// ── the seeded feed ─────────────────────────────────────────────────────────

const MINUTE = 60_000;

/** id · author · parent · minutes before now · catalog key */
type SeedComment = readonly [string, AuthorId, string | null, number, MessageKey];

/**
 * The watering question. Twelve replies, and the thread inside it is the point:
 * Sajid answers Rafiq, Rafiq answers back, and two of the twelve are the expert.
 */
const P1_COMMENTS: readonly SeedComment[] = [
  ['c1.1', 'rafiq', null, 110, 'community.c1.1'],
  ['c1.2', 'sajid', 'c1.1', 105, 'community.c1.2'],
  ['c1.3', 'akram', null, 98, 'community.c1.3'],
  ['c1.4', 'nadeem', null, 90, 'community.c1.4'],
  ['c1.5', 'rafiq', 'c1.4', 86, 'community.c1.5'],
  ['c1.6', 'amna', null, 80, 'community.c1.6'],
  ['c1.7', 'sajid', 'c1.6', 74, 'community.c1.7'],
  ['c1.8', 'shazia', null, 66, 'community.c1.8'],
  ['c1.9', 'akram', null, 55, 'community.c1.9'],
  ['c1.10', 'nadeem', null, 40, 'community.c1.10'],
  ['c1.11', 'shazia', null, 25, 'community.c1.11'],
  ['c1.12', 'sajid', 'c1.11', 20, 'community.c1.12'],
];

/**
 * The leaf curl question, with the photo the design shows. Eight replies, and the
 * expert's answer is the first of them — which is why this card quotes it and the
 * watering question does not (see `topAnswer` in the store).
 */
const P2_COMMENTS: readonly SeedComment[] = [
  ['c2.1', 'amna', null, 295, 'community.c2.1'],
  ['c2.2', 'rafiq', 'c2.1', 288, 'community.c2.2'],
  ['c2.3', 'amna', 'c2.2', 280, 'community.c2.3'],
  ['c2.4', 'akram', null, 260, 'community.c2.4'],
  ['c2.5', 'shazia', null, 230, 'community.c2.5'],
  ['c2.6', 'nadeem', null, 200, 'community.c2.6'],
  ['c2.7', 'rafiq', 'c2.6', 190, 'community.c2.7'],
  ['c2.8', 'akram', null, 120, 'community.c2.8'],
];

/** The farmer's own post. Six replies, no expert — the feed is not all questions. */
const P3_COMMENTS: readonly SeedComment[] = [
  ['c3.1', 'sajid', null, 1430, 'community.c3.1'],
  ['c3.2', 'rafiq', null, 1400, 'community.c3.2'],
  ['c3.3', 'akram', null, 1350, 'community.c3.3'],
  ['c3.4', 'shazia', null, 1300, 'community.c3.4'],
  ['c3.5', 'nadeem', null, 1100, 'community.c3.5'],
  ['c3.6', 'sajid', 'c3.1', 900, 'community.c3.6'],
];

function seedComment([id, author, parentId, minutesAgo, key]: SeedComment, now: number): Comment {
  return { id, author, parentId, createdAt: now - minutesAgo * MINUTE, body: { key } };
}

function seedComments(rows: readonly SeedComment[], now: number): Comment[] {
  // Oldest first, which is the order a thread reads in.
  return rows.map((row) => seedComment(row, now)).sort((a, b) => a.createdAt - b.createdAt);
}

export type CommunitySeed = { posts: Post[]; stories: Story[] };

/**
 * The feed as it is on first launch. A new install with an empty feed reads as a
 * broken feature rather than an unstarted one, and a farmer who has been in this
 * village for years always has neighbours to answer.
 */
export function createSeed(now: number): CommunitySeed {
  const posts: Post[] = [
    {
      id: 'p1',
      author: 'sajid',
      kind: 'question',
      topics: ['cotton', 'water'],
      place: 'wazirabad',
      createdAt: now - 120 * MINUTE,
      body: { key: 'community.post1' },
      likes: 0,
      likedByMe: false,
    },
    {
      id: 'p2',
      author: 'rafiq',
      kind: 'question',
      topics: ['cotton', 'pest'],
      place: 'gujranwala',
      createdAt: now - 300 * MINUTE,
      body: { key: 'community.post2' },
      attachment: { kind: 'image', url: '', placeholder: true },
      likes: 0,
      likedByMe: false,
    },
    {
      id: 'p3',
      author: 'me',
      kind: 'update',
      topics: ['cotton', 'market'],
      place: 'wazirabad',
      createdAt: now - 24 * 60 * MINUTE,
      body: { key: 'community.post3' },
      attachment: { kind: 'image', url: '', placeholder: true },
      likes: 24,
      likedByMe: false,
    },
  ];

  const stories: Story[] = [
    {
      id: 's1',
      author: 'sajid',
      body: { key: 'community.story.body1' },
      createdAt: now - 60 * MINUTE,
      expiresAt: now - 60 * MINUTE + STORY_LIFETIME_MS,
      seen: false,
    },
    {
      id: 's2',
      author: 'rafiq',
      body: { key: 'community.story.body2' },
      createdAt: now - 180 * MINUTE,
      expiresAt: now - 180 * MINUTE + STORY_LIFETIME_MS,
      seen: false,
    },
    {
      id: 's3',
      author: 'amna',
      body: { key: 'community.story.body3' },
      createdAt: now - 30 * MINUTE,
      expiresAt: now - 30 * MINUTE + STORY_LIFETIME_MS,
      seen: true,
    },
  ];

  return { posts, stories };
}

/**
 * The comments for a post, keyed by post id, built from the tables above. Kept as
 * a function of `now` for the same reason as the feed itself.
 */
export function createSeedComments(now: number): Record<string, Comment[]> {
  return {
    p1: seedComments(P1_COMMENTS, now),
    p2: seedComments(P2_COMMENTS, now),
    p3: seedComments(P3_COMMENTS, now),
  };
}
