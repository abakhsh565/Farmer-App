# UX decisions — working log

A running record of interface and journey decisions taken in conversation, the
reasoning behind them, and what is still open. It exists because the *why* of a
design is what a later reader (or a later me) cannot recover from the code alone,
and because several of these decisions reverse earlier rules on purpose.

Read this before changing Home's recommendation area, the credit surfaces, or the
guest/sign-in copy. Where a decision conflicts with an older comment in the code,
this file and the code's own comment should have been updated together — if they
disagree, the code is the bug.

Status of everything below: **implemented, not yet tested.** The suite was not run
for these changes, by explicit instruction. Verification is the next step (§7).

Date range: 2026-10-13 → 2026-10-14. All work is uncommitted.

---

## 1. Home — one recommendation section (was: card + crop strip)

**What changed.** Home used to render two sibling blocks:
`<InsightCard />` (the main crop's advice, or *"No new advice for Cotton right
now."*) and `<CropStrip />` (a tile per crop, each printing its stage and either a
count of live advice or *"Nothing right now"*).

Now there is one section (`InsightCard`, [Insights.tsx](../src/components/insights/Insights.tsx)):

- **A crop appears only if it has live advice.** The main crop first, then the
  others in the order they were added. Rows are advice rows — crop name, stage,
  title, body, source and confidence, the action, and *Done* — identical for every
  crop, with the main crop marked by a *Main crop* chip rather than styled
  differently.
- **No advice anywhere → nothing renders.** No empty card, no "nothing right now"
  row. Silence is the honest empty state; a card saying "no advice" spends a row
  of the screen reporting a non-event.
- **Guest, with a crop, and no advice → a sign-in card in the same place**, using
  `prompt('session.why.advice')` to open the one sign-in sheet
  ([Creditsheet entry point note](#5-credit--the-card-is-a-door-not-a-ledger)).

**Why the strip was merged rather than kept.** Two consecutive blocks both
reporting "nothing" read as duplication, and the tiles re-used the *actionable*
brand colour for an empty state while being `disabled`. One list, one utterance.

**What was given up, deliberately.** The old rule — *"a crop that has none says so
rather than disappearing"* — is reversed. The honest-inventory job now belongs to
Profile's farm strip, which lists the crops. The rule that survives is the
important one: **recommendations still evaluate independently**, so a cotton alert
can never suppress a wheat one; each crop's advice is its own record.

**Open question (1).** Should the merged section keep a header at all
(`TODAY FOR YOUR CROP`, singular) when it can now list several crops? Today the
label is unchanged and each row names its own crop.

## 2. Guest surfaces — no figures, an invitation instead

**Rule.** Before sign-in, screens show *no money and no farm figures*. Not a zero,
not a dash: a balance or a crop count belongs to an account, and rendering "Rs. 0"
is a claim about a farmer the app has not met.

**What is shown instead — the crop card and the credit row, decided 2026-10-14
(fourth revision).** Home has one card for the farmer's crop and one row for credit:

| surface | for a guest | for a farmer with an account | reason shown by the sheet |
| --- | --- | --- | --- |
| crop card, advice slot (`CropCard`, [Insights.tsx](../src/components/insights/Insights.tsx)) | header *Today for your crop* + *for {crop}*, then *Advice made for your crop* / *Sign in. It follows {crop} — this phone, or the next.*, then a text `Sign in` | the advice list, or no list at all | `session.why.advice` |
| — the scanner row, on that same card | *Crop check* / *Works without internet* (`scanCta.title` / `.offline`) | the same row | — (works without an account) |
| credit row (`HomeScreen`) | *My Credit* / *What you owe, and to whom* (`profile.credit` / `quick.credit.note`) | the credit card with the total (§3) | `session.why.creditBook` |

**Fifth revision, same day — presentation, not structure.** The card, the rows and
their order were called perfect and left alone; three things changed inside them:

1. The advice slot is laid out **the way it was before any of this work**: the
   section label, the crop named at the end of that row, the line beneath it, the
   action under that. `insight.by` (*for {crop}*) and `insight.signIn.action`
   (*Sign in*) exist again for it.
2. The action is a **text button** — brand-coloured words, no fill, no border.
3. The scanner row was **renamed only**: `scanCta.title` is now *Crop check* in
   English. Nothing moved, no layout changed. The Urdu label stays
   *اپنی فصل دیکھیں* (“see your crop”) — it was never a translation of *Check my
   crop* and reads better than a literal *فصل کی جانچ*; flagged for the copy review.

**Sixth revision, same day — the header row is gone for real, and the sentence got
short.** The farmer's screenshot still showed a header above the advice slot
(*Today for your crop* on the left, *for {crop}* on the right); it was removed from
the render in revision 5 but its strings were still in the catalog, so the row is
now deleted outright — `insight.today` and `insight.by` no longer exist in either
locale, and nothing referenced them. The guest body was also too long-winded to
carry its meaning (*Advice for {crop} shows up here — on this phone, and the next.*
→ **Sign in to see what your crop needs.**): one short line, action then benefit,
no promise about the next phone. The sentence is also **general** — it does not
name the crop, whether in the string or in the call (`t('insight.signIn.body')`,
no `{crop}` passed): the card already names the crop, and the invitation should be
the same for every farmer. Everything else on the card is untouched.

**The mandi rates strip is gone, same day — Home.** The farmer removed it with a
screenshot of the whole block. Every tile it could draw came from the seeded
non-authoritative `research_feed`, nine days old, so the section showed three
prices next to a badge that said *Research feed* and a *stale · 9d* warning on
each one: the app telling the farmer, three times, not to trust the numbers it was
printing. The rule this file already holds for the guest credit card applies the
same way — a figure the app cannot stand behind does not get a surface. Removed
from [HomeScreen.tsx](../src/screens/HomeScreen.tsx): the section, its
`SectionLabel`, the three-tile strip, the *Rs. per 40 kg* footnote and the
`RateTile` component, with its now-unused `RATE_COMMODITIES` / `useMarketRates` /
`isRateQuotable` references. The `rates.*` strings stay in the catalog unused for
the day a real AMIS source is decided; the market service, its fixture and its
tests are untouched. `App.test.tsx` now asserts the section's *absence* so it
cannot come back by accident.

**The one part of the old card NOT restored:** the signed-in empty line, *No new
advice for {crop} right now.* A farmer with an account and no advice still gets no
advice row at all, because that is what the same review asked for in revision 2
("show when u have really advice if not never show"). If the empty line is wanted
back for that state, it is one branch and one key.

**What the fourth revision reversed, and why.**

- **The copy came back.** *Advice made for your crop* + *Sign in. It follows {crop} —
  this phone, or the next.* was deleted in revision 3 and asked for again
  explicitly; it is restored as `insight.signIn.title` / `.body` (no `.action` key —
  the whole block is the tap target, so there is no button to label).
- **The two-tile grid became a card and a row.** A tile cannot hold a title, a
  sentence and a second action.
- **The scan block is gone, absorbed into the crop card** as a row: same flow, same
  destination, one line instead of a full-width block with its own lead copy. The
  long body (*Take a photo and get the problem and the right treatment*) was cut
  with it; *Works without internet* was kept because it is a real property of the
  flow, not decoration. `scanCta.body` and `quick.crop.note` were deleted.

**Copy rules for a guest surface, decided here.**

1. **Never the verb *sign in*, and never *account*.** The label names where the tile
   leads; the note says what is behind it. Identity is asked for by the sheet, in
   the sheet's own words — repeating the ask on the card says the same thing three
   times (label, sentence, button).
2. **No filled button.** A door is a destination, not a checkout: `bg-muted` tile,
   icon, label, one line of note — nothing that looks like a commitment. The same
   applies inside the credit card, whose entry is now words and a chevron
   (`mt-3 flex w-full items-center justify-between`), not the bordered pill it was.
3. **Say what the farmer gets, in the fewest words that stay true.** *Advice when
   needed* promises nothing that is not yet true; the rejected drafts promised
   delivery (*"we'll tell you when your crop needs something"*) from a producer that
   does not exist (§7.4).

**Superseded wording, kept for the record.** Two drafts were rejected in review:

- *"Crop advice needs an account" / "Advice for Cotton is tied to an account, so it
  can follow you to your next phone."* — a policy notice: it answers *where advice
  lives*, not *is something wrong with my crop*, and leads with our constraint.
- *"Advice made for your crop" / "Sign in. It follows Cotton — this phone, or the
  next."* — better voice, but it still said **Sign in** in the body *and* on the
  button, and shipped with a full-width filled CTA. `insight.signIn.*` and
  `credit.guest.*` were deleted with it; the tiles replaced both cards.

## 3. Credit — the card is a door, not a ledger

**Guest.** No credit card is drawn at all — no figure, not even a zero, no shop
line, no button. The way in is the *My Credit* tile above (§2), and only that.
The old card showed a figure, a shop, a progress bar and a *Request credit*
button; then a sentence and a filled *Sign in*.

**Signed in (Home card).**

- One figure: **total outstanding across every shop**, and a sub-line
  *"Across N shops"* (or *"No credit taken yet"*).
- One progress bar over **all** open agreements combined — repaid ÷ borrowed —
  because credit is carried at up to four shops and a bar for one of them would be
  the card picking a favourite.
- The *needs your answer* alert stays (it is a decision, not a new debt).
- **The `+ Request credit` button is gone from the card.** Asking for credit is its
  own flow, entered from the credit screen. A summary card is not a place to start
  new debt.
- The card's single action is an entry row: **"Your shops and history" →** which
  opens the credit screen.

**Credit screen** (bottom sheet, `CreditCenter`):

- *Outstanding now* + the shops section, listed **per shop, not per purchase**:
  shop name, what was bought there, outstanding, repaid %, one tap →
  **that shop's own page** with the outstanding total, the purchases still open
  (product, outstanding, due term, paid so far), the payment ledger from the
  shop's records, and *History with this shop* (withdrawn, rejected, expired
  requests).
- Requests in flight, requests needing an answer, and global history stay as
  they were, above and below the shops.
- *Request credit* remains a separate view inside this screen
  (`credit.form.title`), reached from its own button.

**The four-shop limit.** A farmer may ask many shops — the request side is open —
but may only **carry open credit at four shops at once**
(`MAX_CREDIT_SHOPS`, [store.ts](../src/credit/store.ts)). `shopsHoldingCredit()`
counts shops (not agreements), and `submit()` refuses a fifth *new* shop with
`credit.error.shopLimit`; a shop that already holds credit may always be asked
again. Closing an agreement frees a place. The credit screen states the limit
under the shops heading (`credit.shops.limit`).

**Open questions (2).** (a) Should a *request* in flight count against the four, or
only a committed agreement — today only agreements count. (b) Should the credit
screen become a full screen rather than a bottom sheet, now that it has its own
second and third level of navigation. (c) The products bought are read from the
request records; the PRD's richer per-shop purchase history will come from the
dealer read model (`dealer_products`, `orders`).

## 4. Defect fixed in passing — the guest's name

`farmer.guestName` was `'Login'` / `'لاگ ان'`, so every guest read
*"Assalam o Alaikum, Login"* on Home and saw the label *Login* on Profile. The key
was added in uncommitted work with a placeholder value that was never corrected.
Set to `'Guest farmer'` / `'مہمان کسان'` — Home shows the first word (*Guest*),
Profile the whole label. This was breaking 10 existing tests, unrelated to any of
the work above.

## 5. Earlier fixes kept for the record

- **RTL direction icons.** The Profile sign-in arrow and the change-number back
  arrow now carry `rtl:rotate-180` ([ProfileScreen.tsx](../src/screens/ProfileScreen.tsx),
  [IdentitySheet.tsx](../src/session/IdentitySheet.tsx)). Only direction-bearing
  icons are mirrored; decorative ones (plus, camera) are not.
- **Close buttons.** Sheet and dialog close crosses moved from physical `right-4`
  to logical `end-4` ([sheet.tsx](../src/components/ui/sheet.tsx),
  [dialog.tsx](../src/components/ui/dialog.tsx)) — pinned right, they landed on the
  first word of every right-aligned Urdu title.

## 6. The sign-in form — an email address could not be typed into it

**Reported:** "in sign in i cant enter email why??? its just enter no".

**Cause, in one line of code.** The contact field guessed its own channel from what
it held — `contact.includes('@') ? raw : nationalDigits(raw)` — so every character
typed before an `@` was stripped as a stray digit: `ali@shop.com` arrived as
`@shop.com`, and the first three keystrokes appeared to do nothing at all. The
field also asked for `inputMode="tel"` until the `@` existed, and a numeric keypad
has no `@` on it — on a phone the address was not merely hard to type, it was
impossible.

**First fix — a Mobile/Email toggle. Reverted the same day.** It solved the
keyboard but split a field that did not need splitting, and the owner asked for
one input with the placeholder back.

**The fix that stands: one field, and the rule reads the characters rather than
waiting for an `@`** ([CredentialSheet.tsx](../src/session/CredentialSheet.tsx)).

```
onlyNumberCharacters(raw)  →  digits, spaces, + ( ) . - only  →  national form, capped at 11
otherwise                  →  an address being typed          →  kept exactly as typed
```

- The keyboard is `inputMode="email"`: the one layout carrying both the `@` a
  number never needs and the digits an address never needs. **Trade-off, accepted:**
  a phone number is typed on a slightly busier keypad than a numeric one.
- Label *Number or email*, placeholder **`Enter phone/email here ...`**
  (`credential.contactPlaceholder`, restored with the new wording). The old
  instruction-style placeholder (*Enter your number or email to continue.*) is gone.
- `credential.contactLabel` exists again; `scanCta.body`-style deletions do not
  apply here.

**Verified in the running app** (not by test), on the live sheet:

| typed | field holds |
| --- | --- |
| `ali@shop.com` | `ali@shop.com` |
| `ali` *(the case that was impossible before)* | `ali` |
| `0300 12345678999` | `03001234567` — capped at eleven |
| `+92 300 1234567` | `03001234567` — country code folded |

Also read back from the DOM: `label` *Number or email*, `placeholder`
*Enter phone/email here ...*, `inputMode` `email`, `type` `text`.

## 7. What is pending

1. **Verification, partly run 2026-10-14 (sixth revision).** `tsc --noEmit` is
   clean; the Home checks pass in the running app (no *Mandi rates*, no *Research
   feed*, no *per 40 kg*; *Advice made for your crop* / *Sign in to see what your
   crop needs.* / *Sign in* / *Crop check* all render); `src/i18n/locales.test.ts`
   passes. The suite itself is **39 failed / 306 passed / 1 skipped**, and none of
   the failures is from §1–§6: they are stale assertions from the auth and profile
   redesign — old copy (*Not signed in* → *Tap to sign in*, *Create your account* →
   the *Sign in* sheet), plus a *Dealers* heading assertion where *My Dealers* now
   opens the sign-in sheet first. Affected: `App.identity`, `App.credit`,
   `App.location`, `App.locationSearch`, `App.journeys`, `App.isolation`,
   `App.chat`, `App.search` and three cases in `App.test.tsx`. **Not yet done:**
   updating those assertions, and one new test each for (a) "no advice → no advice
   list", (b) "guest with a crop → the copy, the scanner row and the credit row",
   (c) `credit.error.shopLimit`, (d) the contact field accepting an address letter
   by letter (the regression this file records twice), (e) "Home has no mandi rates
   strip", which `App.test.tsx` now covers as the absence check.
2. **Copy review in Urdu.** All new strings are written in the app's register but
   were not reviewed by a speaker: `insight.signIn.*`, `credential.contactPlaceholder`,
   `quick.credit.note`, `session.why.creditBook`, `credit.home.shops`, `credit.entry`,
   `credit.shops.*`, `credit.shop.*`,
   `credit.error.shopLimit`, `session.why.advice`.
3. **Unused keys.** Deleted from both catalogs because nothing could render them
   any more: `insight.none`, `insight.noAdvice`, `insight.otherCrops`,
   `insight.by`, `insight.signIn.*`, `credit.guest.*`. Still present (2 locales
   each) but no longer rendered anywhere:
   `credit.ledger`, `credit.home.open`, `credit.section.agreements` — either use
   them again or delete them; dead copy is copy that drifts.
4. **The recommendation producer does not exist.** The insight surfaces are built
   for advice nothing generates: `createSeed` is empty, no client code constructs
   an `Insight`, and the server side (`recommendations`, `farmer_insight_feed()`,
   `emit_recommendation()`) is written but not connected. Until a producer lands,
   the section can only ever be empty or a guest prompt. Weather, spray timing and
   the pest knowledge entries are the intended bases (see
   [PRD-ALIGNMENT.md](./PRD-ALIGNMENT.md) §4).
