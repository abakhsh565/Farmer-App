# Verification report — cross-user isolation, fixture data, visit lockout

Date: 4 October 2026
Scope: the two reported bugs (previous farmer's name/phone visible after logout;
dealer chat and credit visible to the next user), plus the fabricated-data and
flow defects found while auditing them.

Everything below was executed against the running app and the running Supabase
project. Where a claim is unverified it says so; nothing is marked passing on the
strength of reading the code.

---

## 1. The reported bugs

### 1.1 Sign-out persistence — CONFIRMED FIXED, end to end

Driven through the real UI in a browser with stable storage, against the real
Supabase project `swmbmtvwgksicfnfsehg`.

| Stage | Observed |
|---|---|
| Fresh install | `agri-shop.session` = `{"account":null,...}`, chat `threads:{}`, credit `requests:[]` |
| Real OTP sign-in (code `123456`) | "Signed in as Bakhtawar Khan", party `b0da419c-7763-44e1-886a-5e711ce9c113` |
| Page reload | **"Assalam o Alaikum, Bakhtawar"** — session restored from the phone |
| Sign out | session → `{"account":null}`, Supabase auth token **removed** |
| Reload after sign out | **"Guest farmer"**, **Rs. 0**, **"No credit taken yet"**, chat `threads:{}` |

Supabase auth token confirmed `REMOVED` after sign-out — the previous farmer's
access token is not left alive on the phone.

### 1.2 The reload bug that was *not* a bug

An earlier session left an open question: the session document reverted to the
seed on every reload. That was investigated rather than assumed, and the cause was
the test harness, not the app.

Control experiment — a key with no relationship to the app:

| Probe | Incognito tab | Normal tab |
|---|---|---|
| `PROBE_PERSISTENCE_TEST` survives reload | **no — `null`** | **yes** |
| Device id across reload | rotates each time | stable |

The incognito context issues a fresh storage partition per navigation
(`device-b379af1dde2f` → `device-dfb13fc059a0` → `device-0fad2e8ecb94`). On the
normal tab the session survives reload intact. No application change was needed.

---

## 2. Defects found and fixed in this pass

### 2.1 Fabricated farm data on Profile

`ProfileScreen` rendered `Cotton · 8 acres · Wazirabad` on **every** install,
from catalog strings. No part of the app collects an acreage; `8 acres` was a
literal. On a shared phone this is the same defect as the reported name leak —
data belonging to nobody reads as the previous farmer's.

Fix: `farmer.acres`, `farmer.village` and `farmer.place` were **removed from the
catalog entirely**, so they cannot render. The strip now reads from the stores
that hold the data — primary crop and crop count from insights, place from the
saved location — and says "No crops yet" / "Not saved yet" when there is nothing.

Also fixed: `areaNameKey()` fell back to `farmer.village`, an area lookup
pointing at a farmer-identity key. Now `area.wazirabad`.

### 2.2 Invented crop and advice profile

`insights` seeded two crops (Cotton, Wheat) and three pieces of advice on every
install, so a new farmer opened the app to a pink bollworm alert about cotton
they had never planted. The advice was internally consistent and entirely
invented — the worst combination, because it looks like the product working.

Fix: the seed is now empty. `addCrop` / `removeCrop` were added to the store so a
crop list can grow by the farmer's own choice, with derived ids (so the same crop
is not added twice) and main-crop handover on removal. Both recommendation
surfaces already handled "no crops" correctly and now render nothing rather than
something untrue.

**Trade-off, accepted knowingly:** with no add-crop *screen*, first-run Home has no
recommendation area. Weather, spray advice, the scan CTA, mandi rates, dealers
and credit are unaffected.

### 2.3 Field visit — permanent lockout after a refusal

Found by driving the whole loop rather than the happy path. The dealer profile
read the *latest* visit request whatever its status and hid the "Request a field
visit" button whenever one existed.

Consequence: once a shop declined, the farmer could never ask that shop again —
while the app's own copy read *"The dealer cannot come this week. You can ask
again later."* The store always allowed the retry; only the screen refused to
offer it.

Fix: `canAsk = visit === undefined || visit.status === 'rejected'`.

**Regression test proven in both directions** — reverting the one-line fix makes
the test fail; restoring it makes the test pass.

---

## 3. Coverage matrix

Counts below are measured from the files, not estimated.

| Flow | Tests | Notable cases covered |
|---|---|---|
| Community | 24 UI + 37 unit | filter, empty state, moderation (report/block/unblock), tombstone deletion, offline queue + recovery, storage failure + retry, reload persistence, rate limit, attachment validation, blocked-term filtering |
| Identity-on-action | 9 UI | post/reply/story/message/credit/visit/expert gates, wrong code, **expired code**, unreachable provider, draft preserved, sign-in completes the action |
| Isolation | 3 E2E | two farmers one phone: name, chat, credit, phone number, crops; isolation not deletion; no fabricated farm figures |
| Journeys | 3 E2E | field visit (gate → request → dealer answer → restart), refusal → **ask again**, sign-out → sign-in returns work |
| Credit | 4 UI + 23 unit | counteroffer diff, final approval, consent gate, duplicate refusal, transitions, overpay, closed agreement, payment ledger |
| Chat | 4 UI | reads without account, empty thread for new shop, persistence across reopen, migration into account, search + no-match |
| Location | 4 UI + 9 unit | temporary area never replaces saved, explicit save only, gate on save, radius ceiling |
| Resilience | 3 UI | retry, phone's own data over an error screen, "not syncing" stated honestly |
| Insights | 10 unit | empty first run, add/idempotent/remove, main-crop handover, document round-trip |
| Visits | 6 unit + E2E | duplicate refusal, re-ask after refusal, decision only while pending, missing request |
| Services | 83 unit | Open-Meteo (11), geocode (9), map tiles (5), remote gateways (8), Supabase client (5), repository + config (44), location (9), analytics (6) |
| Session | 13 unit | phone/email validation, hydrate of partial documents, sign-out, context migration |
| i18n | 17 unit | measured coverage: en 100%, ur 100%; formatting |
| Scan / misc | 10 unit | assistant honesty rules, off-domain refusal, initials |

**Total: 27 files, 291 passed, 1 skipped. Typecheck clean.**

---

## 4. Verified against live services

- Supabase `client_document_get` refuses a foreign owner (`insufficient_privilege`)
- Own `chat` read allowed; collection check constraint includes `chat`
- Test account's stale `client_documents` purged (`remaining_documents = 0`)
- Live RPCs return 401 for a session with no matching token — authorization enforced
- Weather (Open-Meteo) and market rates (`market_rates`) returning 200
- Dealers (`dealers_within_radius`) returning real shops with stale-stock badges

## 5. Open / not verified

1. **No add-crop screen.** `addCrop`/`removeCrop` exist in the store with full
   unit coverage, but no farmer can reach them. Until that ships, first run has no
   recommendation area. This is the honest consequence of removing the seed.
2. **Pre-existing flake.** `App.identity.test.tsx > code expired` fails
   intermittently under parallel load (1,200 ms code lifetime vs 1,400 ms wait).
   Passes 3/3 in isolation. Pre-existing; not introduced here, not yet hardened.
3. **Provider gaps.** `.env.local` has no AI/OTP/dealer/analytics endpoints, so the
   Profile "Data & services" panel correctly reports those as *Development*.
   Real SMS needs Twilio.
4. **No device or emulator.** APK is build-verified only, not run-verified.
5. **Responsive matrix not executed** — no tablet/large-phone/RTL sweep recorded yet.
6. **Nothing is committed.** All work since `33efbc3` is uncommitted, including
   everything in this report.
7. **Seed fixtures persist on existing installs.** See §6.2 — a full reinstall or
   clearing app data is required to shed them.

## 6. Final pass

### 6.1 One Supabase client, not three

Found in the running app's own console, not by reading code: every load produced

```
GoTrueClient@sb-…-auth-token:1/2/3  Multiple GoTrueClient instances detected in the
same browser context … undefined behavior when used concurrently under the same
storage key.
```

**Cause.** `getSupabaseClient` cached the *client* but checked the cache *before*
`await import('@supabase/supabase-js')`. The await yields, so every caller arriving
in the same tick passed the check with the cache still empty and built its own
client. Seven call sites reach for it at startup (location ×3, remote gateways,
`supabaseAuth`, `SessionProvider`).

**Measured.** Five concurrent callers:

| | clients received | all the same? |
|---|---|---|
| before | **5 distinct** | no |
| after | **1** | yes |

Browser console warnings went **3 → 0** on a clean load.

**Fix.** Cache the in-flight *attempt* (`clientAttempt`), so creation is one
operation that concurrent callers await. Regression test added, and proven both
ways: commenting out the dedupe line fails it, restoring passes it.

*Note on the test:* the guard asserts on the **identity of the returned clients**,
not on the create-call count. The count reads `1` whether or not the bug is present
— with a mock in place the real package is still resolved alongside it — so it was
removed from the assertion rather than left in as decoration.

### 6.2 The old seed is still on the device

Removing the seed from `createState()` fixed *new* installs only. This browser still
held `crop-cotton`, `crop-wheat`, `insight-cotton-pest`, `notif-1/2` and
`credit-order-seed-1` in localStorage, so Home still showed Cotton and Wheat.

There is **no version or migration seam** in `services/persistence.ts` — each store's
`hydrate` accepts whatever shape is on the phone — so nothing reconciles a document
written by an older build.

**Impact is limited:** no build carrying the seed was ever released, so this affects
developer and test devices only. Anyone who ran an earlier build must clear app data.

### 6.3 Fresh-install honesty, re-verified live

Checked on a clean storage partition rather than by inference. First run writes:

```
agri-shop.insights  {"crops":[],"insights":[],"notifications":[]}
agri-shop.credit    {"requests":[],"agreements":[]}
```

Home renders weather (live Open-Meteo), spray advice, the scan card, **Rs. 0** credit,
real mandi rates honestly badged `stale · 7d`, and real nearby dealers. No invented
crop, no invented pest. This is the screen §3 was about, and it is now truthful.

### 6.4 Suite

`npm run typecheck` clean. **27 files, 294 passed, 1 skipped** (was 291 — the three
new client tests).

## 7. The location page

### 7.1 What it is

The map button on the dealer list opened a map *inside the list*, which pushed the
shops off screen the moment a farmer went looking for their village. Choosing where
you are is a different job from browsing shops, so it is now a page of its own:
address (type it, use the device fix, or tap the map) → how far to look → Save.

The range used to be a local `10` in `DealersScreen` and a second constant in
`ScanScreen`, with a third hardcoded on Home. All three read one value now,
`LocationProvider.radiusKm` — device-persisted under `agri-shop.radius`, and
adopted from the saved location's own `radiusKm` when the account has one, because
the radius the *server* searches with is part of that record.

Nothing is written until Save. Turning the range up and leaving changes nothing,
which is the same promise the temporary search area already makes.

### 7.2 Verified live

- Map button → its own page (tab bar hidden), address field, range tabs, and a
  real MapLibre basemap: 10 km active, coordinates `32.4430, 74.1150`
- **Save disabled** for a guest who has picked nothing — the district default is
  not saved in their name as if they had chosen it
- Widening the range via Search settings → `agri-shop.radius = "25"` and the list
  header reads **"3 dealers within 25 km"**, so the value reached the real query
- Console clean apart from the pre-existing `SheetOverlay` ref warning, and
  **zero GoTrueClient warnings** (§6.1 holds)

### 7.3 Not verified: an end-to-end save

Sign-in is unavailable here (§7.4), so the write path — `farmer_location_save` —
was never exercised against the server. The guest gate and the page's structure are
covered by tests; the server write is not.

### 7.4 Sign-in is broken, and the services panel says otherwise

Signing in returned:

```
Error sending confirmation OTP to provider: Authentication Error - invalid username
```

Supabase *is* configured in this environment, so the app uses `supabaseAuth` — real
Supabase Auth SMS — and the project has no valid SMS provider credentials. The
Profile "Data & services" panel reports `Otp — Development`, which describes the
*custom OTP endpoint* seam rather than the auth path actually in use. It therefore
reads as "handled by a development provider" while sign-in is in fact unavailable,
which is the kind of claim this report exists to catch.

### 7.5 Suite

**28 files, 297 passed, 1 skipped.** Typecheck clean; design lint clean; three new
tests in `src/App.setLocation.test.tsx`, with MapLibre stubbed because it needs
WebGL and jsdom has none.

### 7.6 Limitation

The reused `LocationPicker` still carries hardcoded English strings ("Use my
location", the search placeholder, its notices). It was previously behind a toggle
and is now a full page, so in Urdu the page mixes languages. Cataloguing it is the
next step.

## 8. The search page (12 Oct)

### 8.1 What it replaces

The dealer list filtered by shop *name* only. A farmer who typed "urea" got an
empty list and reasonably concluded nobody nearby stocked it — the product half of
the question had nowhere to be answered. Searching is now a page of its own, opened
from that box, with two answers and one keyword.

- **Before a keyword:** up to four suggested shops and four suggested products,
  both read from the dealer service, so a suggestion cannot name a shop that has
  stopped trading or a product nobody carries.
- **While typing:** matches for both types, live, without confirming.
- **After confirming:** `Dealers` and `Products` tabs, each showing its own count,
  sharing the keyword — swapping tabs cannot lose what was typed.
- **Editing the keyword** returns the page to suggesting, because results about a
  word no longer in the box are results that lie.

New capability rather than a screen over the old one: `searchProducts` on
`DealerProvider`, so the UI never learns a provider's name. `ProductHit` is a
*listing* — the same product at two shops is two rows with each shop's own price.

### 8.2 Verified live

Against the real project, not fixtures:

- Suggestions listed 3 real shops (each within 25 km) and 4 real listings with the
  shop and distance on every row
- Typing `roundup` narrowed to the one listing that exists
- Enter → `Dealers · 0` / `Products · 1`, keyword intact in the box
- Products tab: `Roundup · Bayer · 1 litre · Quantity not reported ·
  Kissan Pesticides & Fertiliser Centre · 1 km`, priced **"price on asking"**
  because the row's `unit_price` is NULL — which is what NULL must render as
- Console clean

### 8.3 The fan-out, and why it is disclosed

There is no product-search function on the server, so the remote provider composes
`dealers_within_radius` with `dealer_products_for` for the **nearest 8 shops**.
Searching part of the area and presenting it as all of it is the failure this layer
exists to prevent, so the number asked is named in the source label, which the
Products tab shows verbatim: `Supabase dealer projection (nearest 3 shops)`.

A request per keystroke would be a burst per word, so the question waits 300 ms
behind the input (`useSettled`). The field itself never lags — only the question
does.

### 8.4 Defect found while verifying: a chat header showing a raw UUID

Opening a conversation from a search result showed the dealer's **raw id** as the
shop's name: `350705-e08b-4bf f-99df-ff004d346…`.

**Cause.** `lineText` in `src/screens/ChatScreen.tsx:288` resolves a name in two
ways — the catalogue, then a prettifier that turns `dealer.aliTraders` into "Ali
Traders". Neither works for a real shop from the dealer system, whose id is a UUID:
`dealerNameKey` misses it, and splitting a UUID on `.` produces the UUID back. So a
shop the app *can* name — the search result had just rendered it as "Kissan
Pesticides & Fertiliser Centre" — is shown as an identifier instead.

**Not introduced here, and not fixed here.** It predates the search page (the same
Chat button on the dealer list reaches it) and the repair is in the chat store, not
the search page: the service-reported name needs to travel with the thread. Left
reported rather than quietly widened, with the exact line so it can be picked up.

### 8.5 Suite

**29 files, 302 passed, 1 skipped.** Typecheck clean; design lint clean; five new
tests in `src/App.search.test.tsx`.

## 9. Anyone can set their location (12 Oct)

### 9.1 The gate is gone

Saving a location required an account, because the server was the only place one
could live — which made the app's first genuinely useful act, telling it where you
are so the shops it lists are the ones near you, the one thing you could not do
without signing up.

A location is not *said to anyone*: it is not a post, a message or a credit
request, and writing it down publishes nothing. So it now has a device form as well
as an account form. A guest's choice is kept on the phone and drives exactly the
same screens; signing in hands it to the account, once, and the device copy is
dropped so there is only ever one answer to "where is this farmer". Signing out
still leaves nothing behind, so the next person holding the phone is not shown the
previous farmer's village.

The identity gate remains where something *is* said to someone: posting, messaging
a dealer, asking for credit, and the field visit in `DealerScreen`.

### 9.2 Copy that would have become a lie

`location.savedHint` reads "Saved to your account." — shown to a farmer who has no
account, that is a false statement about where their data is. A second key,
`location.savedHintDevice` ("Saved on this phone."), is chosen from a new
`savedOnDevice` on the location value. Verified live: the Dealers screen reads
**"Saved on this phone."** for a guest.

`session.why.location` — the gate's own explanation — is now unreachable and was
pruned from both catalogs.

### 9.3 Defect found live, introduced by this change

Split state, caught by comparing the two documents in the running app:

```
agri-shop.location   { … "radiusKm": 25 }
agri-shop.radius     "100"
```

A saved location carries a radius, and the provider adopted it on *every* change to
the saved record. That was harmless while only accounts had one. Once a guest could
have one, the two device-scoped values fought: the filter wrote the phone's
preference (100), the saved record still held the older number (25), and the older
one won at every launch — so a range a farmer had chosen silently reverted the
moment they reopened the app.

**Fix.** The record's radius is adopted from the *account* — where it is the number
the server actually searches with — and never from the phone's own copy. One owner
per value: the account when there is one, the phone otherwise.

**Proven both ways.** The regression test in `App.location.test.tsx` fails when the
old behaviour is re-inserted ("Unable to find … /dealers within 25 km/", at the
restart assertion) and passes with the fix. Live afterwards: `agri-shop.radius`
`"100"` and the list reading **"0 dealers within 100 km"** — not reverted.

### 9.4 A gap this change makes easy to reach

With a saved location in Alipur, the dealer list is correctly empty — the dealer
projection only holds shops around Wazirabad. But the empty state says *"Increase
the radius or search another area"* when the radius is already at its 100 km
ceiling, and the button that would raise it is hidden at exactly that point, so the
screen asks for something impossible and offers nothing. Not fixed here: it is a
design decision, and unasked.

### 9.5 Suite

**29 files, 307 passed, 1 skipped.** Typecheck clean; design lint clean.