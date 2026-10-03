# PRD alignment ledger

Status of the two source documents (`PRD Farmer App.pdf`,
`Rules and regualriotn Farmer App.pdf`) against what exists in this repository.

**Read section 1 first.** It is the honest summary, and it says the one thing that
matters most: the backend is written but not connected, so the running app is
still an on-device application.

Status vocabulary, as required by the brief:

| Status | Meaning |
| --- | --- |
| **VERIFIED** | Working, and I have evidence: a passing test, a command output, or a build artifact |
| **BUILT** | Written and structurally checked, but not yet executed against the real dependency |
| **MODELLED** | Rules encoded and tested, running on local or seeded data rather than the real source |
| **BLOCKED BY EXTERNAL CREDENTIAL** | Complete except for a key or account (see [CREDENTIALS-REQUIRED.md](./CREDENTIALS-REQUIRED.md)) |
| **NOT BUILT** | No code yet. Owned as a gap, not hidden |
| **FUTURE / OUT OF SCOPE** | Deliberately deferred, not a defect |

Evidence commands, all currently passing:

```
npx tsc --noEmit              → clean
npm run lint                  → design check passed
npm run lint:migrations       → 17 files, 54 tables, 54 with RLS
npx vitest run                → 17 files, 222 tests passed
npm run build                 → built
npm run apk                   → artifacts/farmer-app-debug.apk (5.4 MB)
```

---

## 1. The honest summary

**What is real and verified:** the complete approved UI; guest-first identity gating;
the credit state machine; field visits; canonical insights; sourced weather and
rates; the scan domain gate; the Community tab; a locale framework with five
regional languages registered; and an **installable Android APK** produced by one
command.**What exists but is not yet used:** the service layer. `src/services/` now holds
the contracts, complete development providers, remote providers that read the
normalised database services, and a `Repository` boundary with both a local and a
Supabase implementation. It is mounted in `App.tsx` as `ServicesProvider`.

**And every store is now on it.** Session, credit, field visits, insights,
community and dealer chat read and write through the `Repository` boundary and
through `usePersistentDocument`. No screen and no store touches `localStorage`
directly; the device copy is the document layer's business, and it is mirrored
*per owner*.

That last detail was a real defect found by writing an end-to-end test rather
than by reading the code: with one unscoped key per collection, signing out left
the account's posts, credit requests and conversations on a shared phone, and the
next person to open the app was shown them until the backend answered. Three
further defects fell out of the same pass and are fixed: the write queue stored
the in-memory state object where the reader expected the document's own bytes
(so a stored document could never be read back, and a failed read overwrote it),
the write effect pushed the *guest's* document up during a sign-in before the
load had established whose document it was, and the dealer listings quoted on a
scan result were a second copy of the dealer's price rather than the dealer's own
number. `src/App.journeys.test.tsx` and `src/App.resilience.test.tsx` are the
tests that caught them, and they stay as regression cover.

**Second gap:** there are no Edge Functions (`supabase/functions/` does not
exist), so nothing is scheduled or integrated server-side: no ingestion, no
notification dispatch, no AI gateway. The AI and OTP providers are written
against endpoints that do not exist yet, and fail loudly rather than silently
when they are unconfigured.

**Third gap:** the migrations have never been executed. There is no local Postgres
and no running container runtime in this environment, so they are checked
statically by `scripts/check-migrations.mjs` (quoting balance, reference ordering,
duplicate definitions, RLS coverage) and are labelled BUILT, not VERIFIED.

**The APK is a debug build running in local mode.** It is genuinely installable
and contains the real app, but with no backend credentials compiled in. See
[ANDROID-BUILD.md](./ANDROID-BUILD.md).

---

## 2. Identity and access

| PRD requirement | Status | Implementation | Evidence |
| --- | --- | --- | --- |
| Guests browse, read, search, view weather and market, use non-account actions | VERIFIED | `src/session/SessionProvider.tsx`; RLS grants `anon` read on catalogues, community feed, rates, weather (migration 0013) | `src/App.identity.test.tsx`; manual walkthrough |
| Identity requested only for ownership, persistence, communication, publication, financial accountability, authenticated writes | VERIFIED | `requestIdentity(action, reason)` gates post, reply, story, dealer message, credit request/accept, field visit, expert escalation | `src/session/store.test.ts` (13 tests), `src/App.identity.test.tsx` (5 tests) |
| The interrupted action resumes after sign-in rather than being lost | VERIFIED | Pending action held in a ref, never persisted | `src/session/store.test.ts` |
| Backend authorization is authoritative | **NOT BUILT** | No client adapter, so nothing reaches the database. RLS and guarded RPCs are written but not consulted | — |
| Identity is proven, not merely typed | **BLOCKED BY EXTERNAL CREDENTIAL** | Current sign-in accepts a phone (`03` + 9 digits) or email with no proof of possession | SMS/OTP provider in the credential report |
| Farmer and dealer identities never merge by phone number | BUILT | `parties.kind` is a two-species enum; the only farmer↔dealer relation is `dealer_farmer_links`, which must cite an explicit act. Automatic matching is not expressible | `20261003000200_identity.sql`; static check passes |
| Dealer customer records are not imported during farmer signup | BUILT | No import path exists; `party_contacts` uniqueness is for duplicate *detection*, and the comment says so | `20261003000200_identity.sql` |
| Integration only when the farmer explicitly enters a dealer workflow | BUILT | `request_field_visit` and `credit_submit_request` create the link, citing the act | `20261003000600_field_visits.sql`, `20261003000700_credit.sql` |
| Account deletion and sign-out are authenticated-only | VERIFIED | `src/screens/ProfileScreen.tsx`, two-step confirm | Manual walkthrough |

## 3. Crops, facts and personalisation

| PRD requirement | Status | Implementation | Evidence |
| --- | --- | --- | --- |
| Several active crop instances, one marked primary | BUILT | `crop_instances` with a partial unique index for the primary | `20261003000300_crops.sql` |
| Confirmed facts and inferred signals kept separate | BUILT | Separate tables; `crop_facts.source_kind` has **no** `inferred` member, so a guess cannot be stored as a fact even by direct SQL | `20261003000300_crops.sql` |
| An inference never silently overwrites a confirmed fact | BUILT | `confirm_inference_as_fact()` is the only promotion path; it supersedes (preserving) and audits, and infers nothing | same file |
| Crop lifecycle respected, corrections recorded with a reason | BUILT | Ordered-stage trigger; backward moves require a reason via `correct_crop_stage()`; `crop_stage_history` | same file |
| Behaviour produces signals, not facts | BUILT | `behaviour_signals`, separate from `crop_facts` by construction | same file |
| Signals carry source, timestamp, crop/context, and decay | BUILT | `signal_weight()`: strong decays over ~1 year, moderate ~180 d, weak ~90 d, never reaching zero | same file |
| Behaviour influences relevance without generating notifications on its own | BUILT | `signal_relevance()` returns a score; nothing inserts a recommendation from it | same file |
| Farmer context and personalisation feeding the UI | **NOT BUILT** | No client adapter; the app uses seeded crops | — |

## 4. Recommendations, knowledge and notifications

| PRD requirement | Status | Implementation | Evidence |
| --- | --- | --- | --- |
| One canonical Recommendation/Insight object | BUILT | `recommendations` table; `farmer_insight_feed()` is the single read model for Home *and* notifications | `20261003000400_recommendations.sql` |
| Home, notifications and crop detail reference the same event | BUILT | `notification_events` has **no body column** — only a reference. Duplicating prose is not expressible | same file |
| No separate conflicting versions per screen | BUILT | Duplicate advice is a unique-violation on `recommendations_dedupe_idx` | same file |
| The same advice cannot be emitted twice | BUILT | `emit_recommendation()` is idempotent by dedupe key and returns the existing live row, so retries and concurrent callers converge | same file |
| Expired advice is not shown as current | BUILT | `valid_until` filtered in the feed; `job_expire_recommendations()` retires it and its notification | `20261003001400_jobs.sql` |
| Advice cites its knowledge source and version | BUILT | `agri_knowledge_entries` with `provenance`, `reviewed_by`, `version`; recommendation carries `knowledge_version` | `20261003000400_recommendations.sql` |
| Agricultural knowledge architecture | BUILT | Entries plus `agri_knowledge_index` (vector column nullable → keyword-only degraded mode, disclosed) | same file |
| On-device notification list referencing insight ids | VERIFIED | `src/components/insights/Insights.tsx`, notifications carry `insightId` | `src/App.test.tsx`; manual walkthrough |
| Real notification delivery (push) | **BLOCKED BY EXTERNAL CREDENTIAL** | Schema and `notification_kind` exist; no provider | Firebase in the credential report |
| Notification dispatch pipeline | **NOT BUILT** | No Edge Function | — |

## 5. Weather and market

| PRD requirement | Status | Implementation | Evidence |
| --- | --- | --- | --- |
| Provider abstraction; not hard-coded to a vendor | BUILT | `weather_providers` table names WeatherAPI.com as the initial candidate; the app reads the table | `20261003001100_market_weather.sql` |
| UI weather and AI weather come from the same normalised service | BUILT | `latest_weather()` is the single read path, returning freshness with the numbers | same file |
| Source and freshness always shown | VERIFIED | Home shows source, age, and stale/unavailable states | `src/screens/HomeScreen.tsx`; `src/App.test.tsx` |
| Advice paused when the reading is unusable | BUILT | `weather_is_usable()` is the gate; `weather_freshness()` labels fresh/stale/expired/unavailable in one place | same file |
| Market ingestion: AMIS → adapter → validation → normalisation → observations → internal API | BUILT (schema) / **BLOCKED** (adapter) | `market_observations` keyed by source/commodity/market/day; ingestion runs recorded; `market_rates()` serves | same file |
| Never turn a missing value into zero | BUILT | Price columns are nullable with a "some price present" check; the comment explains 0 ≠ unknown | same file |
| Never invent a rate | BUILT | `market_rates()` reports `is_recent` instead of estimating | same file |
| Historical observations preserved | BUILT | Upsert keyed by day; `raw` payload retained per row | same file |
| Daily updates supported | BUILT | Unique key allows one row per day per market; re-running updates | same file |
| Live market rates in the app | MODELLED | Seeded records, maize deliberately stale to exercise the stale path | `src/data/market.ts` |
| Weather API key | **BLOCKED BY EXTERNAL CREDENTIAL** | — | Credential report |
| AMIS feed access | **BLOCKED BY EXTERNAL CREDENTIAL** | No key invented, as the PRD requires | Credential report |

## 6. Dealers and field visits

| PRD requirement | Status | Implementation | Evidence |
| --- | --- | --- | --- |
| Dealer system is the source of truth; app is a read-facing projection | BUILT | `dealer_profiles`/`dealer_products` carry `source_system`, `source_ref`, `synced_at`, `sync_state` | `20261003000500_geo_dealers.sql` |
| Stale or missing dealer information shown as such | BUILT | `sync_state` fresh/stale/unreachable; `mark_stale_dealer_projections()` on a schedule; `available_qty` nullable (NULL ≠ 0) | same file, `20261003001400_jobs.sql` |
| Proper geospatial logic | BUILT | PostGIS `geography(Point,4326)` generated from lat/lon, GiST index, `ST_DWithin` with KNN ordering via `operator(extensions.<->)` | same file |
| Maximum radius 100 km | BUILT | CHECK constraint on both radius columns **and** clamped again in `dealers_within_radius()` | same file |
| Temporary search area must not change the farmer's location | BUILT | Separate `farmer_temporary_areas` table with expiry; the RPC takes an origin parameter and never writes the profile | same file |
| Dealer search, profile, distance, hours, reasons | VERIFIED | `src/screens/DealersScreen.tsx` | `src/App.test.tsx`; walkthrough |
| Field visit Pending → Accepted / Rejected | BUILT | `visit_status` enum plus a transition guard that names the allowed edges | `20261003000600_field_visits.sql` |
| Not turned into chat | BUILT | Visits are a request lifecycle; the guard records transitions and rejects a chat-shaped status change | same file |
| Architecture allows Scheduled → In Progress → Completed / Cancelled | BUILT | All seven enum values exist; the transition table lists them, and the actor guard makes enabling them a policy decision | same file |
| One open request per dealer | BUILT | Partial unique index over non-terminal statuses | same file |
| Only the dealer may accept or reject | BUILT | Actor check inside the transition trigger, independent of the RLS policy | same file |
| Dealer sync from the POS | **BLOCKED BY EXTERNAL CREDENTIAL** | Interface and bookkeeping exist (`dealer_sync_runs`) | Credential report |
| Field visits in the app | VERIFIED (on-device) | Request from a dealer profile, plus a demo dealer answer | `src/App.test.tsx`; walkthrough |

## 7. Credit

| PRD requirement | Status | Implementation | Evidence |
| --- | --- | --- | --- |
| The exact approved workflow | BUILT + VERIFIED on-device | Server FSM in migration 0007; client FSM `src/credit/store.ts` | `src/credit/store.test.ts` (24 tests), `src/App.credit.test.tsx` (4 tests) |
| One active request per underlying context | BUILT | Partial unique index on `(dealer_id, order_ref)` over non-terminal statuses | `20261003000700_credit.sql` |
| One counteroffer maximum | BUILT | Partial unique index `where is_counteroffer`; the RPC also raises a readable error first | same file |
| No counter-counteroffer | BUILT | CHECK: a farmer may only author version 1; a later version may only be a shop-owner counteroffer | same file |
| Farmer explicitly accepts the *displayed* terms | BUILT | `credit_farmer_accept` requires the caller to name the version it rendered; a mismatch is an error, and the consent row stores the shown snapshot | same file |
| Changed counteroffer terms explicitly shown | BUILT | `changed_fields` computed **by the server** from the two versions; a no-change "counteroffer" is refused | same file |
| Final Shop Owner approval required | BUILT | `credit_owner_final_decision` is the only path to `accepted` | same file |
| Only final approval commits | BUILT | The `credit_agreements` insert *is* the commit | same file |
| Duplicate commit protection | BUILT | `unique (request_id)` on agreements; a retry fails loudly rather than lending twice | same file |
| Original request, counteroffer, decisions, terms, version, actor, timestamps preserved | BUILT | Append-only versions, decisions and consents | same file |
| Paid ≤ outstanding | BUILT | `credit_record_payment` locks the agreement row, refuses overpayment and refuses payment on a settled debt | same file |
| No negotiation engine, no invented lending rules | BUILT | No such code; the workflow is the approved one and no more | same file |
| Counteroffer → accept → final approval, end to end on device | VERIFIED | The stored document confirmed `['awaiting_final_approval','accepted','rejected']` | `src/App.credit.test.tsx` |
| Credit against the real database | **NOT BUILT** | No client adapter | — |

## 8. Community, moderation and expert verification

| PRD requirement | Status | Implementation | Evidence |
| --- | --- | --- | --- |
| Guest read, identity to write | VERIFIED | RLS `anon` select policies; write policies require `auth.uid()` | `src/App.community.test.tsx`; walkthrough |
| A deleted post leaves the answers written to it | BUILT | `community_replies.post_id` is `ON DELETE RESTRICT`; author deletion is a soft delete that blanks the body only | `20261003000800_community.sql` |
| Report → case → review → action → audit | BUILT | Reports have **no outcome column**; `moderate_apply()` records and applies in one transaction | `20261003000900_moderation.sql` |
| A report must not automatically equal deletion | BUILT | No path from `community_reports` to a punitive effect; intake only opens or joins a case | same file |
| AI may detect and prioritise, not decide irreversibly | BUILT | CHECK: `performed_by_kind = 'automated'` permits only `dismiss`/`escalate`; punitive outcomes additionally require a named human | same file |
| Outcomes: dismiss, warn, hide/restrict, remove, escalate | BUILT | Enum plus per-target application | same file |
| Moderation is auditable | BUILT | Every action writes to the shared `audit_log` | same file |
| Verification requires verified identity **and** a verifiable qualification | BUILT | `grant_expert_verification` refuses without a verified `party_contacts` row and ≥1 human-confirmed, unexpired qualification | `20261003001000_expert_verification.sql` |
| Not granted from community reputation | BUILT | There is no reputation input; the function has no such parameter and the table has no such column, by design | same file |
| Final authority is Admin/Moderation; auditable | BUILT | Admin capability required; status history plus shared audit log | same file |
| Verification expires and can be suspended | BUILT | `expires_at`, `suspended_at`, `job_expire_verifications()` revokes the capability | same file, migration 0014 |
| Community feature in the app | VERIFIED (on-device) | Feed, threads, stories, report, block, delete, offline queue | `src/App.community.test.tsx`, `src/community/*.test.ts` |
| Moderation queue **UI** for moderators | **NOT BUILT** | Schema and RPCs exist; no reviewer-facing surface | — |
| Expert application **UI** | **NOT BUILT** | Schema exists; no applicant or reviewer screens | — |

## 9. AI and scan

| PRD requirement | Status | Implementation | Evidence |
| --- | --- | --- | --- |
| Agricultural AI only, not a general chatbot | VERIFIED | Domain gate refuses off-domain questions with a stated reason | `src/scan/analyze.test.ts` (7 tests) |
| Word-boundary matching so "spray" does not match "pray" | VERIFIED | Fixed; Latin terms match on boundaries, non-Latin keep substring | same file |
| Confidence and uncertainty stated before the answer | VERIFIED | Threshold 70; uncertainty line rendered above the result | `src/App.test.tsx` |
| Product evidence chain with registration number | VERIFIED | Scan asserts registration `DPP-PK-2019-0431` and live listings | `src/data/products.ts`, `src/App.test.tsx` |
| AI must not invent prices, stock, verification, credit status, regulatory status | BUILT (schema) | Those values are referenceable only through their own tables; the AI gateway will read the normalised services | migration 0004, 0011 |
| AI reads the same weather and market services as the UI | BUILT | `latest_weather()` / `market_rates()` are the only read paths | migration 0011 |
| The AI itself | **BLOCKED BY EXTERNAL CREDENTIAL** | No model provider key | Credential report |
| AI gateway Edge Function | **NOT BUILT** | — | — |

## 10. Media, retention and observability

| PRD requirement | Status | Implementation | Evidence |
| --- | --- | --- | --- |
| Client-side compression where practical | **NOT BUILT** | No compression step in the client | — |
| Server-side validation | BUILT | `validate_media_upload` enforces per-class MIME allowlists and size caps, and rejects rather than converts | `20261003001200_media_retention.sql` |
| Display representation vs higher-quality analysis representation | BUILT | `representation` column separates `display` from `analysis`, linked by `derived_from` | same file |
| Processing states | BUILT | `media_state`: pending → uploading → processing → ready / failed / purged | same file |
| Private storage buckets | BUILT | Four buckets inserted with `public = false` | same file |
| Retention: voice ~7 d, AI media ~30 d after result, traces ~14–30 d | BUILT | `retention_policies` holds the numbers as **data**, and `schedule_media_purge()` dates each asset from the right event | migration 0001, 0012 |
| Failed and temporary uploads cleaned automatically | BUILT | `purge_stale_uploads()` on an hourly schedule | same file, migration 0014 |
| Important structured history retained | BUILT | Superseded facts, versions, decisions, consents, audit rows are never deleted | migrations 3, 7 |
| Retention jobs actually running | **BLOCKED BY EXTERNAL CREDENTIAL** | Scheduled in `pg_cron`, unscheduled gracefully when cron is absent; needs a database | Credential report |
| Technical defaults are not presented as legal policy | BUILT | Stated in the table comment and in the policy `rationale` text | migration 0001 |
| Observability and error handling | **NOT BUILT** | No tracing, no error reporting | — |
| Analytics (PostHog) | **NOT BUILT** | — | — |

## 11. Localisation

| PRD requirement | Status | Implementation | Evidence |
| --- | --- | --- | --- |
| Urdu default and first-class | VERIFIED | `ur` typed as a full `Record<MessageKey, string>`, so a missing string is a compile error | `src/i18n/catalog.ts` |
| English | VERIFIED | Same parity guarantee | same file |
| Punjabi, Saraiki, Sindhi, Pashto **architecture** | VERIFIED | Registry with direction, script, translation status and fallback chains | `src/i18n/locales.ts`, `src/i18n/locales.test.ts` (10 tests) |
| Proper RTL behaviour without duplicated logic | VERIFIED | Direction is a locale property; one `dir` attribute plus Radix `DirectionProvider`; the design lint bans physical direction utilities | `src/i18n/LocaleProvider.tsx`, `scripts/check-design.mjs` |
| Punjabi written in Shahmukhi, not Gurmukhi | VERIFIED | Tag `pa-Arab-PK` asserted by a test, so the script cannot silently change | `src/i18n/locales.test.ts` |
| A missing string never renders a raw key | VERIFIED | Fallback chain, asserted for every locale × every key | same file |
| Punjabi, Saraiki, Sindhi, Pashto **translations** | **NOT BUILT** | Measured coverage: pa 2.3%, sk 2.0%, sd 2.0%, ps 2.0%, all marked `scaffold` | printed by `src/i18n/locales.test.ts` |
| Voice enabled only where quality is validated | **NOT BUILT** | No voice pipeline | — |

The honest reading: the framework is done and tested; the translations are not
done. An assertion in `locales.test.ts` fails if anyone marks a regional locale
`complete` without actually completing it. Agricultural terminology — disease
names, dosages, chemical names — is deliberately excluded from the scaffold,
because a wrong disease name on a spray recommendation is a safety problem and
needs a domain translator, not a general one.

## 12. Application, build and delivery

| PRD requirement | Status | Implementation | Evidence |
| --- | --- | --- | --- |
| Real, installable mobile application | VERIFIED | Capacitor Android shell; the approved web UI is packaged rather than reimplemented. The APK's `assets/public/assets/*.js` hashes match the current `dist` build, so the package carries this pass's code | `artifacts/farmer-app-debug.apk`, 5.4 MB |
| APK reproducible locally with exact instructions | VERIFIED | One command, with JDK and SDK auto-detection | `npm run apk`; [ANDROID-BUILD.md](./ANDROID-BUILD.md) |
| All approved screens and navigation | VERIFIED | Six tabs plus the Community feature | `src/App.tsx`; walkthrough |
| Loading, error, empty and offline states | VERIFIED (partly) | Empty and error states throughout; offline queue for Community only | `src/App.test.tsx`, `src/App.community.test.tsx` |
| Offline behaviour beyond Community | **NOT BUILT** | Other screens assume a live connection | — |
| Location-permission onboarding | **NOT BUILT** | Area is a seeded profile field, never a device permission | — |
| Release signing / Play submission | **FUTURE / OUT OF SCOPE** | Debug APK only; the signing identity is a business decision | [ANDROID-BUILD.md](./ANDROID-BUILD.md) |
| Native React Native + Expo rewrite | **FUTURE / OUT OF SCOPE** | The brief locks the UI; a rewrite would rebuild every approved screen. The WebView consequence is stated plainly rather than glossed | `capacitor.config.ts` |
| Remote feature configuration / observability | **NOT BUILT** | — | — |

## 13. Testing

| Requirement | Status | Evidence |
| --- | --- | --- |
| Type checking | VERIFIED | `npx tsc --noEmit` clean |
| Lint (design-system conformance) | VERIFIED | `npm run lint` |
| Migration chain structure | VERIFIED | `npm run lint:migrations` — 17 files, 54 tables, ordering, duplicates, RLS coverage |
| Unit tests | VERIFIED | 103 across 8 unit suites |
| Integration / component flows | VERIFIED | `App.test.tsx` (19), `App.identity.test.tsx` (9), `App.credit.test.tsx` (4), `App.community.test.tsx` (24), `App.chat.test.tsx` (4), `App.journeys.test.tsx` (2) |
| Failure and recovery states | VERIFIED | `App.resilience.test.tsx` — a backend that refuses the first write and one that cannot be reached at all, using `FlakyRepository` / `UnreachableRepository` against the real stores |
| Database tests against a real Postgres | **NOT BUILT** | No database available in this environment |
| RLS / authorisation tests | **NOT BUILT** | Policies written; never executed. The negative tests that matter — one farmer reading another's credit file, a guest writing, a dealer accepting a visit they were not asked for — are specified in the credential report's activation plan |
| Idempotency and duplicate-action tests | MODELLED | Covered at the store level (`store.test.ts`); not exercised against the database |
| Browser / mobile E2E automation | **NOT BUILT** | No Playwright or equivalent; flows were walked by hand |
| Regression suite | PARTIAL | The 222 tests act as regression cover for what exists; the database-side negatives remain unwritten |

---

## 14. What I would do next, in order

1. Apply the migrations to a dedicated Supabase project and run the negative RLS
   tests. Until that happens, 54 tables of carefully constrained schema are an
   untested claim.
2. Write the Edge Functions: AI gateway, weather ingest, market ingest, dealer
   sync, notification dispatch, media processing. The client providers are
   already written against them, and every store is already on the repository
   boundary, so this is the step that turns the local providers into live ones.
   (The stores themselves are done — see section 1.)
3. Build the moderator queue and expert-application surfaces — the workflows are
   fully enforced server-side but have no human interface yet.
4. Complete the regional translations with a domain translator, and raise the
   coverage assertion's floor as each locale lands.
5. Rebuild the APK against the real environment and re-walk all twelve flows —
   and install it on a real device, which this environment cannot do (no handset
   attached, no emulator image installed).
6. Replace the two remaining fixture reads that are not yet behind a service:
   the insights feed's seeded cards and the profile's farm figures. Both are
   read-only and neither affects a rule, but they are the last direct fixture
   reads in a screen.
