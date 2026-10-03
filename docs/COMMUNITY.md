# Community — the feature, its rules and its moderation

The Community tab is where farmers in the same area ask each other things, answer
each other, and share what happened in the field. It is the only screen in the app
where the user is the content, so it is the only screen with rules of conduct, a
way to report something, and a way to stop seeing somebody.

This file is the reviewable surface for all of that. **The rules themselves live in
code, not in this document**: `src/data/community-rules.ts` holds every limit, the
term filter, the report reasons, the guidelines, the ladder of consequences and the
terms. Change that file and the app changes with it, in both languages. This file
explains what the code does and why, so that whoever changes it knows what they are
changing.

---

## 1. Where it lives

| Concern | File |
|---|---|
| The rules, limits, term filter, report reasons, guideline and terms copy | `src/data/community-rules.ts` |
| Posts, replies, authors, topics, villages, filters, the seeded feed | `src/data/community.ts` |
| What may be published — pure functions returning a message key | `src/community/validate.ts` |
| Feed, threads, counts, moderation, the persistence codec | `src/community/store.ts` |
| Phone storage, hydration, the clock, the offline queue | `src/community/CommunityProvider.tsx` |
| Screen: feed, states, sheets, the two floating buttons | `src/screens/CommunityScreen.tsx` |
| Cards, threads, composer, stories, moderation sheets | `src/components/community/*` |
| Words, in both languages | `src/i18n/catalog.ts` (`community.*`, `time.*`) |
| Relative times ("2h", "1d") | `src/i18n/format.ts` → `formatRelativeTime` |

Two invariants hold across all of it, and both exist because breaking them produced
defects elsewhere in this app:

1. **Seeded words are message keys, never finished strings.** Post 1 is
   `community.post1`, so the whole feed — including twelve seeded replies — reads in
   Urdu after a language switch, not half in English.
2. **Numbers are counted, never drawn.** "12 replies" is twelve comment rows;
   "Expert answered" is derived from who actually answered; the like count is state.
   A number typed into a component is wrong the moment the thing it counts changes.

## 2. What a farmer can do — the flows

| Flow | Path | Notes |
|---|---|---|
| Read the feed | Community → feed | Newest first, under the chosen filter chip |
| Filter | All / Questions / Cotton | Each chip carries its own rule (see `FILTERS`) |
| Open a thread | Tap a post's text | Nested replies, two levels of indent |
| Ask a question | FAB → Question → topic + village → Post | Shows the "good question" tips |
| Share an update | FAB → Update → Post | Same composer, no tips |
| Reply | Thread → type → Reply | Replies carry photos and voice too |
| Answer a specific reply | Tap **Reply** on that reply | The box says who it is answering |
| Attach a photo or video | Camera icon | Type and size checked before it is accepted |
| Record a voice note | Mic icon (hidden if the device cannot) | Auto-stops after 60 s |
| Like | Heart on a card or in the thread | One tap, one like |
| Report | ⋯ → Report → reason | Reasons are a list, not a text box |
| Block somebody | ⋯ → Block {name} | Their posts leave the feed; the row says so and can be undone |
| Delete own content | ⋯ → Delete | Answered posts become tombstones |
| Add a story | The **Add** ring | 24 hours, then it expires on its own |
| Watch a story | Tap a ring | Marks it read; advances on its own after 5 s |
| Read the rules | The shield in the header | Rules, consequences and terms |

## 3. Education: what the product teaches, and where

Moderation is the last resort; the first resort is teaching people how to be
answered. Four places do that, all driven by `community-rules.ts`:

- **The composer's tips** (`community.tip.1–3`, shown only when the kind is
  *Question*): name the crop and the village, attach a close photo of the leaf, say
  what you have already sprayed. This is what turns "my crop is sick" into a
  question somebody can answer.
- **The kind picker** — a *Question* and an *Update* are different things, and
  saying which one you are writing sets what the reader expects.
- **The topic and village chips**, so a post is labelled by the person who knows,
  not guessed by the reader.
- **The rules sheet** (shield in the header), readable *before* anything goes wrong,
  including what happens if a rule is broken.

## 4. Moderation

Three separate things, deliberately not merged:

**(a) What the product refuses to publish** — enforced on the device, in
`validate.ts`, before anything is stored. Every refusal names itself on screen.

| Rule | Limit | Where |
|---|---|---|
| Nothing empty | whitespace-only is empty | `checkEntry` |
| Length | post 500 · reply 300 · story 150 characters | `POST_MAX`, `COMMENT_MAX`, `STORY_MAX` |
| Disallowed terms | abuse and scam phrases, matched case-insensitively in three scripts | `BLOCKED_TERMS` |
| No repeats | the same text as one of your last three entries | `DUPLICATE_LOOKBACK` |
| Posting speed | 5 entries per minute | `RATE_LIMIT_COUNT`, `RATE_LIMIT_WINDOW_MS` |
| Attachment type | `image/*`, `video/*` only | `ALLOWED_MEDIA_PREFIXES` |
| Attachment size | 10 MB | `ATTACHMENT_MAX_BYTES` |
| Voice length | 60 s, enforced by stopping the recorder | `VOICE_MAX_MS` |

The order matters: what the farmer wrote is checked before how fast they are
writing, so a burst of bad posts is told what is wrong with the text rather than
told to slow down.

**(b) What the farmer can do about somebody else** — report, block, and nothing
else. A feed that lets a farmer punish another farmer decides who is right by who
is louder. Reporting records a reason against the content and confirms it; the
author is never told who reported them (`community.report.body`). Blocking hides
the author's posts and leaves a row saying how many, with the unblock next to it —
a block the user cannot see or undo is indistinguishable from a bug.

**(c) The ladder of consequences** — written, not implemented, because the
enforcement belongs to whoever runs the service: first time the content is removed
and the reason given; repeated, a seven-day silence; serious or continuing
(threats, fraud, somebody else's phone number), loss of access and a criminal
matter goes to the police.

**What is deliberately absent:** no downvotes, no crowd-based hiding, no
"reporters decide" queue, no moderator role in the client. There is no server, so
there is no cross-device moderation either — see §7.

## 5. Privacy and terms

The terms a farmer is shown (`community.terms.1–4`) state four things, and the code
keeps all four:

- Your name and village appear on your posts; **your phone number is never shown**
  (nothing in the model carries it).
- Anyone can see what you post, and a photo can carry where it was taken.
- Advice — including the Agri Expert's — is guidance, not a guarantee.
- Posts are saved **on this phone only**. Clearing the app's data removes them, and
  there is no server copy yet. This one is literally true: see the next section.

## 6. Data, storage and privacy of the device

- One key: `agri-shop.community`, written by `CommunityProvider` on every change
  once the feed has loaded. The payload is versioned (`STORAGE_VERSION`).
- Persisted: posts, replies, stories and the block list. **Not** persisted: the open
  thread, the filter and the drafts — a half-written question is session state, not
  something to find on the phone three days later.
- Reading it back is strict: anything that does not fully parse is refused whole and
  the feed is rebuilt from the seed. Half a feed — a post whose replies were dropped,
  a reply with no author — is worse than a known-good one, because the farmer cannot
  tell which half is missing. Expired stories are the only thing dropped quietly.
- Attachments are `blob:` object URLs. They die with the page, so after a reload the
  card says *"This attachment is not saved on this phone"* rather than drawing a
  broken image. Uploading is the fix, and there is no upload (see §7).
- Object URLs are released when an attachment is removed or the box closes, so a
  farmer cannot run their phone out of memory by attaching videos all afternoon.

## 7. Honest gaps

- **No server.** Posts, reports and blocks are one device's. Two farmers cannot see
  each other's questions. Everything above is built so that adding a backend does not
  change a single rule or screen — the store is already a pure function over data —
  but until then the feature is a working prototype of itself.
- **No upload.** Photos and voice notes are local object URLs (see §6).
- **The term filter is a starter list.** Deliberately mild and short, because this
  file lives in a repository: a real deployment replaces `BLOCKED_TERMS` with a
  service, and the "first time / repeated / serious" ladder with a review queue.
- **Reports go nowhere.** They are recorded against the content and confirmed to the
  farmer; there is no moderator to receive them.
- **The seeded content is a fixture.** Three posts, twenty-six replies, three
  stories, written to be plausible: a watering question with a nested argument, a
  leaf-curl case the expert answers first, and a harvest post.
- **No editing.** A question edited after it has answers turns the answers into
  non-sequiturs, so the product offers deleting instead. Tombstones keep the
  conversation readable.
- **No notifications.** Nothing tells a farmer that somebody answered.

## 8. Changing things — recipes

| To do this | Change |
|---|---|
| Add or reword a rule | `RULES` in `community-rules.ts` + `community.rules.N.title/body` in both catalogs |
| Change a limit | the constant in `community-rules.ts`; `validate.test.ts` states the behaviour |
| Add a report reason | `REPORT_REASONS` + one `community.report.reason.*` key pair |
| Add a filter chip | one row in `FILTERS` in `community.ts`, with its `match` |
| Add a topic or a village | `TOPICS` / `PLACES` in `community.ts` + the label keys |
| Add a field to a post | the types in `community.ts`, then `revivePost` in `store.ts` (and bump `STORAGE_VERSION`) |
| Change what a story lives for | `STORY_LIFETIME_MS` |
| Make the feed show something else first | `visiblePosts` in `store.ts` |

Anything that changes the shape of the persisted payload **must** bump
`STORAGE_VERSION`; a mismatch is refused, which reseeds the feed rather than
misreading it.
