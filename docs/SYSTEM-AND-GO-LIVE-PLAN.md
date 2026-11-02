# Farmer App — how it actually works, what data it runs on, and the plan from demo to live

Written 12 October 2026. Every claim about the *running* system below was probed
live from this checkout during this session; the exact commands are in §9, and the
raw results are quoted inline. Nothing here is inferred from a doc that might be
stale — where the existing docs disagree with the running system, that is recorded
in §8.

---

## 0. The short answer, in three parts

### 0.1 "Is this only demo data?"

No — but only **half the app is wired to anything real**, and the half that is
*not* wired is the half that makes it personal. Three distinct mechanisms feed the
five screens, and they are not equally real:

| | What it covers | Where it comes from | Real today? |
|---|---|---|---|
| **A** | Shops near you, their stock and prices, mandi rates, your saved location, and your own records (crops, credit, visits) | The live Supabase project, read through **12 RPCs** — and the records themselves are phone-first, syncing to the server only once someone is signed in | **Real, and verified live today** |
| **B** | Weather, place search | Open-Meteo and OpenStreetMap Nominatim, both keyless | **Real** |
| **C** | Community feed, dealer chat threads, "orders you can ask credit against", the assistant's answers, the scan diagnosis, the six *fallback* shops | `src/data/*.ts` and `src/services/providers/develop.ts` — in the app bundle | **Scripted, deliberately** |

So the honest sentence is: **the utility half is live; the social and personal
halves are authored content standing in for a backend that has not been wired to
them yet.** The reason they look the same on screen is by design — every screen
reads a *capability*, never a vendor (`src/services/registry.ts`), so swapping a
fixture for a live service is a configuration change, not a rewrite. That
architecture is why the gap is closeable in days, not months.

### 0.2 "On what basis is the data populated?"

Two strategies, on purpose, and both are documented in the files themselves:

- **The database layer runs on a *reference seed*, not on a vendor feed.** The six
  shops in the live database are attributed to `source_system = 'reference_seed'`,
  carry `sync_state = 'stale'` with a two-day-old `synced_at`, and have
  `verified_at = NULL` because nobody has visited them. The migration header says
  why in plain words: the app was *structurally complete and visibly empty*, so
  "0 dealers within 10 km" could not be told apart from a broken search. The rates
  are attributed to the pre-existing `research_feed` source — **AMIS is not
  credited with a single number.** Deleting all of it is the one-line statement at
  the top of the file.
- **The social layer runs on *authored fixtures* with rules about honesty.** A
  seeded post attributes nothing to the farmer (one once did — a harvest update
  they never wrote, which on a shared phone reads as a lie). Names, places and text
  are catalogue keys, never finished English strings, so the feed is in Urdu when
  the farmer switches. Numbers on cards are *counted* from rows, never typed in.

The full rule list is in §5. These are product rules from the PRD, implemented as
code rules, and they are the part of this codebase most worth protecting.

### 0.3 "Does it work off the farmer's own profile?"

**Almost nothing does, today — and that is the real answer to your question.** The
whole personalisation chain (crops → crop facts → behaviour signals → scored
relevance → canonical recommendation → Home + notifications) exists *in Postgres*
and is **never called by the app**:

```
grep -rl "crop_instances|behaviour_signals|crop_facts|farmer_insight_feed|parties" src/   →  (no files)
```

The app's crop list is its own client-side document, seeded **empty on purpose**
(`src/insights/store.ts` — "the seed is empty, and the recommendation surfaces say
nothing rather than something untrue"). So Home is empty not because it is broken
but because nothing ever tells it what the farmer grows. Feeding that chain is the
core of the plan in §6.

---

## 1. How the app functions, systematically

Six layers. Each one only knows about the one beneath it.

### Layer 1 — Shell
`src/main.tsx` → `src/App.tsx`. Mounts the providers in dependency order
(`ServicesProvider` → `ThemeProvider` → `LocaleProvider` → `SessionProvider` →
`LocationProvider` → `InsightProvider` → `CommunityProvider` → `ChatProvider` →
`CreditProvider` → `VisitProvider`) and renders five tabs. Nothing else lives here.

### Layer 2 — Feature providers (React context)
`src/session`, `src/location`, `src/insights`, `src/community`, `src/chat`,
`src/credit`, `src/visits`. Each is a pair: a **pure-function store** (all the
rules, testable with no React and no clock) plus a **thin provider** holding one
state object and writing it through the document layer. Screens only ever read
(`useSession()`, `useCredit()`, …).

The identity gate is the important one: `requestIdentity(action, reason)` runs the
action immediately if there is an account, and otherwise opens the sheet **holding
that same action in a ref** so it fires the moment sign-in succeeds. Call sites
never branch on `isGuest`, which is what stops a gated action slipping through a
second code path that someone forgot to check.

### Layer 3 — Document layer
`src/services/persistence.ts`. One JSON document per `(collection, owner)`.
`Collection` = `session | credit | visits | insights | community | chat | crops |
media`. The **owner** decides where it lives:

- account id (a uuid) → phone mirror *and* pushed to `client_documents` on the
  server, with a bounded retry queue that survives a failed write;
- `device-…` (a guest) → **phone only.** The backend cannot accept it: every
  `client_document_*` call is checked against `auth.uid()`, so uploading a guest
  document could only produce an error and a queue that never drains.

Corrupt payloads are archived to `*.replaced` and the feature is rebuilt from its
seed, because half a feed is worse than a known-good one.

### Layer 4 — Service registry
`src/services/registry.ts` + `src/services/config.ts`. `config.ts` is the one place
that reads `import.meta.env` (each key written out literally, because Vite only
substitutes static references), and `registry.ts` turns that into eight live
capabilities. Rules encoded there rather than left to callers: persistence, market
and `auto` weather follow the Supabase flag **together**, so the app cannot
disagree with itself about the same fact; AI, OTP and dealer are chosen
independently, because they are separate endpoints that can deploy at different
times.

### Layer 5 — Providers
`providers/develop.ts` (complete behaviour, no credentials), `providers/remote.ts`
(Supabase RPCs), `providers/openMeteo.ts` (keyless live weather),
`providers/supabaseAuth.ts` (Supabase Auth + `ensure_party()`).

Every read returns `Sourced<T>` — data **plus** `sourceLabel`, `observedAt`,
`freshness` and `status`. That is not decoration: the PRD forbids showing stale
data as current and forbids inventing a missing value, and both rules are only
checkable if the provenance travels with the number. `userService/hooks.ts`
(`useWeather`, `useMarketRates`, `useDealerSearch`, `useStockists`, …) is the only
way a screen reads one.

### Layer 6 — Backend
23 migrations in `supabase/migrations/` (**56 tables, 56 with RLS** — confirmed by
the repo's own `lint:migrations` check), plus 4 Edge Functions. What matters structurally: the **domain state machines** live in the
database, not the client — credit (`credit_*` RPCs), field visits, crop lifecycle,
recommendation emission/dedupe/expiry, community moderation. The client has its own
copy of the credit FSM for instant UI, and the server copy is authoritative.

### 1.1 Two traces

**"Find a shop near me" (the live path).**
`DealersScreen` → `useDealerSearch()` → `registry.dealer` → `SupabaseDealerProvider.search()`
→ `rpc('dealers_within_radius', { p_farmer_id: null, p_lat, p_lon, p_radius_km })`
→ PostGIS `ST_DWithin` + KNN ordering, radius clamped at 100 km in the function
*and* in the CHECK constraint → rows mapped to `DealerSummary[]` **preserving
`null`** (`verified_at`, `open_now`, `available_qty`) → screen renders "not
reported" rather than zero.

**"Ask a question" (the scripted path).**
`ChatScreen` → `useAi` → `config.aiEndpoint.configured ? RemoteAiProvider : DevelopmentAiProvider`.
Today the endpoint is unset, so `DevelopmentAiProvider` answers from a hard-coded
knowledge table inside the bundle. **The server's real AI is live and works** — see
§2 — the app simply is not pointed at it.

---

## 2. The live environment, verified today

### 2.1 What is configured in `.env.local`

| Variable | Set? | Effect |
|---|---|---|
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | **yes** | persistence, market, dealer, OTP all switch to the real backend |
| `VITE_WEATHER_PROVIDER` | `open-meteo` | live weather straight from the vendor, keyless |
| `VITE_AI_ENDPOINT` | **no** | → `DevelopmentAiProvider`: scripted answers and scan results |
| `VITE_OTP_ENDPOINT` | no | (Supabase wins anyway when a backend is configured) |
| `VITE_DEALER_ENDPOINT` | no | (Supabase wins anyway) |
| `VITE_ANALYTICS_KEY` | **no** | → `DevelopmentAnalyticsProvider`: events go to the console only |

### 2.2 The backend is up and returning real data

| Probe | Result |
|---|---|
| `GET /auth/v1/health` | **200** |
| `rpc('dealers_within_radius', {lat:32.443, lon:74.115, 25 km})` | **3 shops** in range — 0.5 / 0.8 / 10.1 km (Al-Madina Agriculture Store, Kissan Pesticides & Fertiliser Centre, Chaudhry Agri Services); all `sync_state:"stale"`, `synced_at: 2026-10-02T03:17Z`, `verified_at: null`, `is_accepting:true`, `used_temporary_area:true`, `effective_radius:25`. The seed holds **6** shops; the other three fall outside 25 km |
| `rpc('dealer_products_for', al-madina)` | **2 listings**: Tilt 250 EC (Syngenta, fungicide, `DPP-PK-2016-0155`, 250 ml, qty 11, ₨1,450, in stock) and Confidor 20% SL (Bayer, insecticide, `DPP-PK-2017-0212`, 100 ml, qty 24, ₨850, in stock) |
| `rpc('dealer_stockists_for', {slug:'roundup'})` | **3 shops**, all `stale`: Kissan Pesticides 0.8 km — price **null**, 1 litre, in stock **null**; Punjab Seed 28.9 km — ₨760 / 500 ml / in stock; Sialkot Agri Mart 38.8 km — ₨1,380 / 1 litre / in stock |
| `rpc('market_rates', {p_commodity:null, p_max_age_hours:48})` | **5 rows, all observed 2026-10-04, all 189.3 h old, all `source_code:"research_feed"`, all `is_recent:false`**: cotton — Sialkot Mandi 8,300/8,700/FQP 8,500; maize — Wazirabad 2,100/2,300/2,200; rice — Gujranwala 3,600/3,800/3,700; wheat — Gujranwala 3,850/4,050/3,950; wheat — Wazirabad 3,820/4,020/3,920 |
| `rpc('client_document_get', uuid)` | `42501 "A client may only read its own documents."` — the ownership guard is real |
| `rpc('farmer_insight_feed', {p_farmer_id:null})` | `[]` — no crop facts exist anywhere, for anyone |
| `rpc('latest_weather', 32.443, 74.115)` | `[]` — **no reading has ever been ingested for the pilot cell** |

### 2.3 — and the AI server, which the app is not using

| Probe | Result |
|---|---|
| `GET /functions/v1/ai/health` | `{"ok":true,"configured":true,"active":"gemini","model":"gemini-2.0-flash","gateway":false}` |
| `POST /functions/v1/ai/ask` (as a **guest**) | `{"gate":"not_covered","confidence":20,"escalate":true,"caveats":["No published knowledge entry matched this question.","Nothing was invented to fill the gap — a person can answer it."]}` |
| `GET /functions/v1/weather-ingest` | ran and reported `{"ok":true,"provider":"open_meteo","readingsWritten":8}` |
| `GET /functions/v1/market-ingest` | `"No market source is configured. Set AMIS_FEED_URL … or MARKET_FEED_URL"` |

Three things follow from this table, and they matter more than anything else in
this document:

1. **All four Edge Functions are deployed and reachable.** The existing docs say
   they are not; that is stale (§8).
2. **Real AI works today, for a guest, without sign-in** — `callerOf()` explicitly
   allows an anonymous caller. Setting `VITE_AI_ENDPOINT` is a one-variable change
   that replaces the scripted assistant with the live one. The `not_covered`
   refusal is the *correct* behaviour of a knowledge-gated assistant whose published
   knowledge is **7 entries** — cotton pink bollworm and whitefly, the wheat sowing
   window and yellow rust, spraying wind, irrigation timing and nitrogen splitting
   (migration `0019`, all marked `Extension bulletin, reviewed`). A question
   *outside* those seven is refused and escalated to a person, which is the PRD's
   rule working exactly as intended.
3. **Weather ingestion works and the app does not use it.** The normalised
   `weather_readings` table is empty for the farmer's area, so `VITE_WEATHER_PROVIDER`
   stays on `open-meteo`. That is acceptable but it is not what the PRD wants: the
   PRD requires the UI and the AI to read *the same* normalised reading so the
   assistant cannot cite a different temperature from the card.

> **Disclosure.** Probing `weather-ingest` executed it: it wrote 8 Open-Meteo
> readings for the default cell `(0.000, 0.000)`. `latest_weather(0,0)` now returns
> a fresh reading; `latest_weather(32.443, 74.115)` still returns nothing. I did not
> intend a write, the function is idempotent per cell/day, and no pilot data was
> touched — but it should be on the record, and it also proves the ingest path
> end-to-end.

### 2.4 And the one thing that is broken

```
POST /auth/v1/otp {"phone":"+920000000000","create_user":true}
→ 422 sms_send_failed
  "Error sending confirmation OTP to provider: Authentication Error - invalid username
   .../twilio.com/docs/errors/20003"
```

`GET /auth/v1/settings` confirms why: `"phone":true, "email":true,
"sms_provider":"twilio", "phone_autoconfirm":false, "mailer_autoconfirm":false`.

**Sign-in does not work, and it is not a client bug.** Supabase Auth is configured
to send SMS through Twilio, and the Twilio credentials in that project are rejected
by Twilio itself (error 20003 = authentication failed). No code change fixes this;
it needs a valid Twilio account (or a different SMS provider) in the Supabase
dashboard.

That single failure is the keystone of the whole remaining plan, because every
accountable action in the product is gated behind it: posting, replying, messaging a
dealer, requesting credit, accepting a counteroffer, requesting a field visit — and
all of the server-side document sync, since `client_document_*` matches rows against
`auth.uid()`.

---

## 3. The complete data inventory

"Source of truth" is the column that answers your question. Everything in the
**Scripted** rows is what you are seeing as demo data.

### 3.1 Live, database-backed

| Dataset | Source of truth today | Populated by | Status |
|---|---|---|---|
| Dealer profiles (6 seeded shops, 3 within 25 km of Wazirabad) | `dealer_profiles`, `source_system='reference_seed'` | migration `0022` reference seed | **Real rows, unverified data** — `sync_state:'stale'`, `verified_at:null`, `verification_source:'pending_field_verification'` |
| Dealer listings & prices | `dealer_products` | same seed (incl. deliberate NULL price / NULL stock rows) | Real rows, marked stale |
| Canonical products | `canonical_products` | migration `0019` knowledge seed | Real rows — exactly **three**: `roundup` (glyphosate), `confidor` (imidacloprid), `tilt` (propiconazole). The app's scan cites its own single copy in `src/data/products.ts` (Roundup only) rather than this table |
| Agricultural knowledge | `agri_knowledge_entries` + `agri_knowledge_index` | migration `0019` | **7 published entries** with provenance: cotton pink bollworm (v3) and whitefly, wheat sowing window and yellow rust, spray wind, irrigation timing, fertiliser nitrogen split |
| Mandi rates | `market_observations`, `source_code='research_feed'` | migration `0022` seed | 5 real rows, **explicitly non-authoritative** — all five 189.3 h old, all `is_recent:false`, so the UI correctly shows every one of them as not current. Note they differ from the client fixture in `src/data/market.ts`: **the database is the source, and it says so out loud** |
| Weather (normalised) | `weather_readings` | `weather-ingest` function | **Empty for the pilot cell.** Ingest proven working (§2.3) |
| Farmer location | `farmer_location_*` RPCs (account) / device document (guest) | the app | Real, small |
| Identity / party | `parties`, `provision_party()`, `ensure_party()` | sign-in → `ensure_party()` | **Zero farmers** — sign-in is broken, so no party exists for anyone |
| Client documents | `client_documents` | the app, for signed-in owners | **Effectively empty** — nobody can sign in |
| Push devices | `push_devices` (migration `0020`) | nothing yet | Empty; no token is ever registered |

### 3.2 Live, external-service-backed

| Dataset | Source | Notes |
|---|---|---|
| Weather (what you see) | **Open-Meteo**, keyless, called from the client | Cannot generate a bill; no key to approve |
| Place search | **OSM Nominatim**, keyless (`src/services/geocode.ts`) | Search only — no map tiles anywhere in `src/` |

### 3.3 Scripted in the app bundle — this is the "demo"

| Dataset | File | What it actually is |
|---|---|---|
| Community feed | `src/data/community.ts` | 3 posts by 6 named "neighbours", 26 replies across 3 threads with a real parent/child shape, 3 stories. Authors, text, topics and places are catalogue keys. Photos are honest placeholders, not broken images |
| Community rules | `src/data/community-rules.ts` | Limits, term filter (3 scripts), report reasons, the enforcement ladder, terms |
| Dealer chat | `src/data/chat.ts` | 4 threads with real message history; unread badges **counted** from trailing dealer messages, not typed in |
| Credit orders | `src/data/orders.ts` | 3 "purchases you can ask credit against" with hard-coded amounts and distances — a stand-in for the dealer's own sales records |
| Fallback shops/products | `src/services/providers/develop.ts` | 6 shops including one at **112 km** to exercise the radius ceiling; full product listings. Used only when no backend is configured — **the running app reads the database instead** |
| AI answers & scan | `src/services/providers/develop.ts` | A scripted knowledge table + diagnosis, used only because `VITE_AI_ENDPOINT` is unset |
| Search areas | `src/data/dealers.ts` | 4 areas; the profile point is Wazirabad |
| Crop/advice seed | `src/insights/store.ts` | **Empty by design** |

### 3.4 Written, tested, and never called by the client

This is the most important table in this document, because it is the gap between
"structurally complete" and "actually working":

| Capability | Exists as | Client calls it? |
|---|---|---|
| Crop instances + lifecycle + stage history | migration `0003` | **No** |
| Crop facts vs inferred signals, decay scoring | migration `0003` (`signal_weight`, `confirm_inference_as_fact`) | **No** |
| Recommendations, dedupe, expiry, notification events | migration `0004` (`emit_recommendation`, `farmer_insight_feed`) | **No** |
| Credit state machine | migration `0007` + 10 RPCs | **No** — the client has its own FSM |
| Field-visit request/accept/reject, one-open-request rule | migration `0006` | **No** |
| Community posts, replies, reports, moderation outcomes | migrations `0008`, `0009` | **No** |
| Expert verification | migration `0010` | **No** |
| Media validation + retention classes | migration `0012` | **No** |
| Jobs: expire advice, mark stale projections | migration `0014` | Nothing schedules them |
| Push dispatch | `0020` + FCM plugin installed | **No** |
| Market ingestion (AMIS adapter) | `market-ingest` function | Blocked: no source configured |

### 3.5 The complete list of what the client can actually ask the database

All 12 RPCs, from `grep -rn "\.rpc(" src/`:

```
farmer_location_get · farmer_location_save · farmer_location_clear
client_document_get · client_document_put · client_document_delete
latest_weather · market_rates
dealers_within_radius · dealer_products_for · dealer_stockists_for
ensure_party
```

Twelve. Seven read, three write documents, two write your location/identity. **There
is no write path for a post, a reply, a message, a credit request, a field visit, a
crop, a fact or a signal.** That is the whole gap in one sentence.

---

## 4. Gap analysis — what stands between this and the PRD

Ordered by how much each one blocks.

| # | Gap | Evidence | Blocks |
|---|---|---|---|
| **G1** | **Sign-in is broken.** Twilio credentials rejected (`sms_send_failed`, 20003) | §2.4 | Everything accountable: posting, messaging, credit, visits, cloud documents, personalisation history |
| **G2** | **The AI endpoint is not wired.** The server works; the app does not call it | §2.3 | Real answers, real diagnosis, Urdu responses |
| **G3** | **No farm-context write path.** Crops/facts/signals/recommendations exist server-side and are never written or read | §3.4 | The entire personalisation chain, the PRD's core promise |
| **G4** | **Community lives only on the phone.** No post/reply/report ever reaches the server | §3.3, §3.5 | Shared knowledge, moderation, expert answers, the network effect |
| **G5** | **Dealer messaging has no transport.** Threads are seeded rows; sending only appends locally | §3.3 | Any real conversation with a shop |
| **G6** | **Credit and field visits run on the client FSM only.** The server FSMs (with one-open-request, counteroffer-once, actor guards) are never invoked | §3.4 | The merchant-credit MVP the PRD locks down, and its audit record |
| **G7** | **No authoritative market source.** `market-ingest` refuses without `AMIS_FEED_URL` | §2.3 | A trustworthy mandi price; today it is `research_feed` and correctly labelled so |
| **G8** | **Weather is not normalised for the farmer's area.** The UI reads the vendor directly, so UI and AI can cite different readings | §2.3 | The PRD's "one normalised reading" rule |
| **G9** | **No push.** Plugin present, table present, no token registration, no dispatch, no Firebase project | §3.4 | Notifications are an in-app list only |
| **G10** | **No media pipeline.** Blob URLs die with the page; no compression, no upload, no retention job | `community/store.ts` | Photos/voice in posts, AI diagnosis from a real photo, the retention policy |
| **G11** | **Dealer projection is a static seed.** No POS sync, no freshness update | §3.1 | "Who has urea near me, at what price, confirmed when" |
| **G12** | **No analytics.** Key unset, events go to the console | §2.1 | Any product measurement at all |
| **G13** | **The knowledge base is 7 entries.** Everything outside cotton pests, wheat rust/sowing, wind, irrigation and nitrogen splitting is refused and escalated | live `not_covered` response | Useful AI coverage — agronomy review capacity, not code work. The refusal itself is correct and must be kept |
| **G14** | **Docs have drifted from the running system** | §8 | Trust in every other doc, including this one |

---

## 5. The rules and strategy already encoded — protect these

These are the product rules the code enforces today. Every one of them was chosen
deliberately and each has a comment explaining why. A plan that breaks one of them
is a plan that breaks the product.

1. **A missing value stays missing.** `NULL` never becomes `0` anywhere: prices,
   stock, quantities, coordinates. Zero is a value a farmer can be offered, so the
   distinction is carried from a Postgres CHECK to the React prop.
2. **Every number travels with its source and its age.** `Sourced<T>` makes it
   impossible to render a reading without also being able to say where it came from.
3. **Stale and unavailable are different sentences.** A stale reading pauses advice;
   a failed call says "not available". They must never share wording.
4. **Advice is paused when the reading is not actionable** (`isWeatherUsable`), and
   the same gate is a single synchronous function so there is exactly one answer.
5. **The UI never invents a recommendation**, and two surfaces never compute two
   versions of one thing — a notification carries an insight **id**, not a copy of
   its words.
6. **Empty beats untrue.** The insight seed is empty on purpose; a
   post is never attributed to the farmer; an unverified shop has
   `verified_at = NULL` and no invented phone number.
7. **Recommendation for one crop must not suppress another**; anti-noise is enforced
   separately (one notification per crop, newest wins).
8. **Behaviour is signal, never fact.** `crop_facts.source_kind` has no `inferred`
   member — a guess cannot be stored as a fact even by direct SQL.
9. **Backward stage moves need a reason**, and are recorded (`correct_crop_stage`,
   `crop_stage_history`).
10. **Identity at the point of action, not at the door.** Guests browse, search,
    read weather and markets, and keep local context.
11. **A guest's documents never go to the server** (`isDeviceDocument`), and signing
    out leaves nothing behind for the next person on a shared phone.
12. **Farmer and dealer identities never merge by phone number.** The only link is
    `dealer_farmer_links`, which must cite an explicit act.
13. **The dealer projection is read-only for clients** (`revoke insert/update/delete`)
    and is the dealer system's data, not ours.
14. **Invariant with the PRD, stated as code:** observed data, inferred signal,
    recommendation, personalized relevance and transactional record are **separate
    objects**. A signal can influence what is surfaced; it can never rewrite the
    source of truth.
15. **No secret in the client.** Anything named `VITE_*` ships inside the APK and is
    readable; vendor keys live in Edge Function secrets.

---

## 6. The plan: from demo data to a working product

Each phase is independently shippable and has an acceptance test that a person can
run. Owner: **You** = needs your account, decision or money; **Me** = code and
database work.

### Phase 0 — Make the environment tell the truth (½ day, no decisions needed)

| Step | Owner |
|---|---|
| Set `VITE_AI_ENDPOINT` to `https://<project>.functions.supabase.co/ai` — the server is already live and accepts guests | Me |
| Decide the weather source: either run `weather-ingest` on a schedule for pilot cells and move to `VITE_WEATHER_PROVIDER=supabase`, or keep Open-Meteo and remove the normalised path from the plan | You |
| Ingest weather for the pilot cells so `latest_weather` is not empty | Me |
| Rewrite the three drifted docs (§8) to match the running system | Me |
| Verify by turning `VITE_AI_ENDPOINT` on and switching the assistant to real answers | Me |

**Acceptance:** the assistant answers a real cotton question with a citation and a
confidence, and the same answer is reached from a guest session; `latest_weather`
returns a fresh reading for the farmer's own coordinates.

### Phase 1 — Sign-in, the keystone (1–3 days, needs an account)

| Step | Owner |
|---|---|
| Get working SMS: fix the Twilio credentials in Supabase → Auth → Providers → SMS, or move to another provider | **You** |
| Or, to unblock development at zero cost today: approve an interim channel — the **email** OTP path already exists in the app (`channel: 'email'`), or a development OTP in a non-production build | **You** decide |
| Verify `ensure_party()` provisions a party on first sign-in and returns a party id | Me |
| Prove two-account isolation: sign in as A, write, sign out, sign in as B — B sees nothing of A's (the isolation test exists; extend it to the live server) | Me |

**Acceptance:** a real farmer signs in on a real phone; a second account sees none
of the first account's documents, location, credit or visits. Until this passes,
nothing else can be verified against the server.

### Phase 2 — Farm context and recommendations, i.e. the PRD's core (4–6 days)

This is the phase that answers "the app doesn't work off the farmer's profile".

| Step | Owner |
|---|---|
| Add the read/write path for crops: create/list/update a crop instance, confirm a stage, correct a stage with a reason | Me |
| Wire behaviour signals: capture search/scan/question/viewed/dismissed as *signals*, never as facts | Me |
| Call `farmer_insight_feed()` for Home and the notification list, and drop the local insight document's role to a cache | Me |
| Make the AI's context (`AiContext.cropCode`, `stage`, `district`, `weatherUsable`) come from that real context, so answers are about *this* farmer's field | Me |
| Keep the anti-noise rule: one notification per crop, plus a global frequency cap | Me |
| Add a "what the app believes about your farm" screen — the PRD requires personalisation to be explainable and correctable | Me |

**Acceptance:** add a cotton crop at the seedling stage; Home shows an insight for
cotton and none for wheat; the AI's answer names the crop and stage without being
told in the chat; correcting the stage changes the advice and leaves an audit row.

### Phase 3 — Community, on the server (3–4 days, needs your moderation decisions)

| Step | Owner |
|---|---|
| Move posts, replies, likes, blocks and stories to the community tables; keep the offline queue (`pending`) as the offline path | Me |
| Wire reports → moderation queue → outcome → audit, using the ladder in `community-rules.ts` | Me |
| Publish a community guideline/terms version and record acceptance (the PRD requires versioned, auditable consent) | Me + **You** (wording) |
| Seed the boards with content that is *attributable and dated*, or leave them empty and fix the empty state | **You** decide |

**Acceptance:** post from one device, see it on another; report it from the second,
act on it as a moderator from the third, and find the audit row.

### Phase 4 — Dealer workflows: messages, visits, credit (4–6 days)

| Step | Owner |
|---|---|
| Dealer messaging transport (table + RLS + realtime or polling), replacing the seeded threads | Me |
| Field visits against `request_field_visit` and the accept/reject transition guard | Me |
| Credit against the 10 `credit_*` RPCs, keeping the client FSM as the optimistic view | Me |
| Replace `src/data/orders.ts` with the farmer's real purchases once the dealer side exists (§Phase 6) | Me |
| Decide who the "shop owner" actually is for the pilot — a real shop, or a staffed console | **You** |

**Acceptance:** a farmer requests a field visit and a credit request against a real
order; a shop owner accepts or counteroffers once; the farmer explicitly accepts the
**displayed** terms; the accepted term version and the audit trail are retrievable.

### Phase 5 — Truth for weather and markets (2–3 days + a source decision)

| Step | Owner |
|---|---|
| Decide the market source and its licence: AMIS access method, or a paid aggregator feeding `AMIS_FEED_URL` / `MARKET_FEED_URL` | **You** |
| Schedule ingestion (weather hourly per pilot cell; market daily after the auction) and the `0014` jobs (expire advice, mark stale projections) | Me |
| Make the Market screen and the AI read `market_rates()` — already true for the screen; make it true for the AI | Me |
| Show `is_recent` and the source on every rate, exactly as today, once the source is authoritative | Me |

**Acceptance:** a rate on screen and the rate the AI cites are the same stored
observation with the same timestamp and source; a day with no auction shows no rate
rather than yesterday's number wearing today's label.

### Phase 6 — Dealer system integration (the long pole, out of scope for MVP)

The POS/projection sync belongs to a separate account. Interface and bookkeeping
already exist (`dealer_sync_runs`, `sync_state`). What is needed is an agreed
extract (shops, products, prices, stock, hours) and a schedule. Until then the
projection stays a labelled seed — which is honest, and is why the UI says "stale".

### Phase 7 — Push, media, measurement, release (4–6 days)

| Step | Owner |
|---|---|
| Firebase project (free, no card) + token registration against `push_devices` + dispatch honouring `notification_events` | **You** create the project; **Me** the rest |
| Media pipeline: client-side compression (adaptive for social, high-quality for diagnosis), upload, processing status, and the retention sweep from migration `0012` | Me |
| PostHog key into Vercel as `VITE_ANALYTICS_KEY` (free to 1M events/month) — turns a dormant feature on with one variable | **You** |
| Release: signed APK/AAB, Play listing, Vercel production deploy, the rules-PDF QA gate (Playwright E2E, DB reconciliation, time-based retention fixtures) | Me + **You** |

---

## 7. What I need from you

In the order that unblocks the most.

| # | What | Why it blocks | Where it goes |
|---|---|---|---|
| 1 | **A working SMS provider** (fix Twilio credentials, or another provider) — *or* approval to use the email OTP channel during development | Everything accountable, and all server-side verification | Supabase → Auth → Providers → SMS. Never paste keys in chat |
| 2 | **A market source decision** (AMIS access route or aggregator) | The mandi price is the app's most-trusted number and is currently a labelled, non-authoritative feed | Edge Function secret `AMIS_FEED_URL` |
| 3 | **Who the shop-owner counterparty is for the pilot** (a real dealer? staffed console?) | Credit and field visits have no counterparty to act on the other side | Product decision |
| 4 | **Moderation and content decisions**: who moderates, what the enforcement ladder is in your words, whether boards launch seeded or empty | Community is the feature that most needs a human owner | Product decision + legal wording |
| 5 | **Retention periods signed off** (raw media and traces vs structured history) | Media cannot be built to a policy that does not exist | Product/privacy decision |
| 6 | **Firebase project** (free) | Push notifications | Vercel env vars |
| 7 | **PostHog project key** (free) | Any measurement of any feature | Vercel env var `VITE_ANALYTICS_KEY` |
| 8 | **Pilot districts and the agronomy reviewer** for the knowledge base | The AI correctly refuses questions its knowledge cannot answer; it needs entries, not code | Content/agronomy work |
| 9 | **Consent and terms wording** (versioned, auditable) | The PRD requires explicit consent records; the plumbing exists | Legal + Me |
| 10 | **The dealer POS extract agreement** | Real prices and stock | Separate account |

---

## 8. Documentation drift found while doing this

The docs in `docs/` are unusually honest, which is exactly why their drift matters.

| Claim in the docs | What is true today |
|---|---|
| `API-INTEGRATION-PLAN.md`: "the `ai` function is not deployed" / "the single blocker is the Supabase CLI login" | **All four functions are deployed and reachable**, and `/ai/health` reports `configured:true, active:gemini` |
| `PRD-ALIGNMENT.md`: "the backend connection was withdrawn… the running app is still an on-device application" | Supabase is configured in `.env.local` again and the live RPCs return real seeded rows |
| `PRD-ALIGNMENT.md` evidence block: `19 files, 238 tests` | The suite is **29 files, 307 passed / 1 skipped** |
| `API-INTEGRATION-PLAN.md` §6: phone sign-in "proven end to end on 4 October" | It fails today with Twilio 20003; the October success must have been a different provider configuration |
| `src/data/weather.ts`, `market.ts`, `products.ts` reference WeatherAPI.com and the AMIS adapter as the candidate | The live path is Open-Meteo + `research_feed`; the vendor files are now only the *shape* contract |
| `package.json` lists `maplibre-gl`; `vite.config.ts` carries a MapLibre worker comment | No map exists in `src/` any more — the dependency and the comment are dead weight |

---

## 9. Reproduce every probe in this document

Substitute your own project URL and anon key. The anon key is public by design; no
secret is used or printed anywhere below.

```bash
SBURL=$(grep '^VITE_SUPABASE_URL=' .env.local | cut -d= -f2-)
SBKEY=$(grep '^VITE_SUPABASE_ANON_KEY=' .env.local | cut -d= -f2-)
H=(-H "apikey: $SBKEY" -H "Authorization: Bearer $SBKEY" -H "Content-Type: application/json")

curl -s "$SBURL/auth/v1/health" "${H[@]}"                      # 200 → backend is up
curl -s "$SBURL/auth/v1/settings" "${H[@]}"                    # which auth channels exist

# The four reads the app actually makes
curl -s -X POST "$SBURL/rest/v1/rpc/dealers_within_radius" "${H[@]}" \
  -d '{"p_farmer_id":null,"p_lat":32.443,"p_lon":74.115,"p_radius_km":25}'
curl -s -X POST "$SBURL/rest/v1/rpc/dealer_products_for"   "${H[@]}" \
  -d '{"p_dealer_id":"270021d4-4e34-4b57-a267-7e16d1f0610d"}'
curl -s -X POST "$SBURL/rest/v1/rpc/market_rates"          "${H[@]}" \
  -d '{"p_commodity":null,"p_max_age_hours":48}'
curl -s -X POST "$SBURL/rest/v1/rpc/latest_weather"        "${H[@]}" \
  -d '{"p_lat":32.443,"p_lon":74.115}'

# The AI server the app is not pointing at (GET health is free; POST /ask calls the model)
curl -s "$SBURL/functions/v1/ai/health" -H "apikey: $SBKEY"
curl -s -X POST "$SBURL/functions/v1/ai/ask" "${H[@]}" \
  -d '{"question":"Meri kapas ke patton par peela rang aa raha hai?","context":{"language":"ur","cropCode":"cotton","district":"Wazirabad"}}'

# The broken sign-in
curl -s -X POST "$SBURL/auth/v1/otp" "${H[@]}" \
  -d '{"phone":"+920000000000","create_user":true}'
```

Client-side evidence, all run this session:

```bash
grep -rn "\.rpc(" src/                       # the 12 RPCs the client can call — no more
grep -rl "crop_instances\|crop_facts\|behaviour_signals\|farmer_insight_feed" src/   # empty
npx tsc --noEmit                             # clean
npm run lint                                 # design check passed
npm run lint:migrations                      # 23 files, 56 tables, 56 with RLS
npm run lint:functions                       # 4 functions, client routes match
npx vitest run                               # 29 files, 307 passed, 1 skipped
```

> **Caveat on the last five:** the typecheck, both lints and the test suite were
> green on the source as it stands, run during this session. They verify the
> *client*, and this document changes no source — so they are context, not a
> verification of anything in §2, which is verified by the live probes above and
> nothing else.
>
> **Read these probes through a JSON parser, not `head -c`.** Three rows in the
> first draft of §2.2 were wrong for exactly one reason: a truncated response ends
> mid-number and still *looks* complete. `"age_hours":1` was really `189.3`; a
> 3-shop list cut short reads like a 6-shop list. Pipe the response into
> `node -e` and print the fields you are about to publish.

---

## 10. One-paragraph summary

The stack is real and well built: a live Supabase backend with 56 RLS-protected
tables, out of which the app reads shops, stock, mandi rates and your own saved
location through twelve RPCs; live keyless weather and live place search; and a
working AI server that the app simply is not pointed at. What is *demo* is
everything social, conversational and personal — the community feed, the chat
threads, the "orders", the scripted assistant — and, more importantly, the entire
personalisation chain, which exists in complete, tested detail in the database and
is never called by any client code. Two things gate turning it real: a working SMS
provider so a farmer can actually sign in, and a write path from the app into the
farm-context tables that the recommendation engine already reads. Everything else
on the list is a source decision, a free account, or a day of wiring.
