# Farmer App — end-to-end completion report

**Date:** 4 October 2026 · **Branch:** `main` · **Backend:** Supabase `swmbmtvwgksicfnfsehg` (live) · **Deploy:** Vercel `farmer-app-one-omega`

This report is written to the rule the brief set: **no actual evidence = no pass**. Every claim below
names the check that produced it. Where something is not done, it is listed as not done.

---

## 1 · What was found broken, and the proof

Seven defects were found by testing the running system rather than by reading it. Each is listed with
the reproduction that exposed it.

| # | Defect | How it was found | Fix |
|---|--------|------------------|-----|
| 1 | A signed-in farmer owned **nothing**. Sign-in created an `auth.users` row and no `parties` row, so `current_party_id()` was NULL and every RLS policy in migration 0013 matched zero rows. | Querying `parties`/`farmer_profiles` counts against `auth.users` in the live project: 1 auth user, 0 parties. | Migration 0021: `provision_party(uuid)` + `on_auth_user_created` trigger on `auth.users`, plus a backfill and an idempotent `ensure_party()` RPC. |
| 2 | **Guest dealer search raised an exception.** `dealers_within_radius(NULL, lat, lon, r)` read the profile into a record and then checked `not found` — which is true when the farmer id is NULL. The UI rendered the error as "0 dealers within 10 km". | Calling the function as `anon` with real coordinates returned `P0002 Farmer <NULL> not found`. | 0021 rewrote the function: coordinates with no farmer id are a legitimate temporary guest search; the signed-in caller is resolved from the session, not from a client-supplied id. |
| 3 | **The app never established a Supabase session.** The OTP flow called our own gateway, which hashes and verifies codes correctly but issues no token — so `auth.uid()` was always empty. | Reading `supabase/functions/otp/index.ts`: `/verify` returns `{ok:true}` and nothing else. | `SupabaseOtpProvider` (Supabase Auth phone/email) + an identity exchange (`ensure_party()`) on verify. Registry test updated to encode the new rule. |
| 4 | **Migration 0018 could not apply.** `ai_product_for_knowledge()` referenced `e.body_local` from a CTE that selected only `id, slug`. | `apply_migration` returned `42703: column e.body_local does not exist`; the whole transaction rolled back. | The CTE now carries `body_local`; a dead tautology in the crop filter was removed. Applied cleanly. |
| 5 | **No location state existed.** Weather, dealers, market and the assistant all read a hardcoded `PROFILE_POINT` (Wazirabad) constant. | `grep PROFILE_POINT` — `useWeather()` took no argument anywhere in a screen. | `LocationProvider` (saved / temporary / default, kept apart) + `farmer_location_save|get|clear` RPCs with server-side validation. |
| 6 | **Three strings asserted things the data did not.** "Mandi rates · Wazirabad" (rows were from Sialkot, Gujranwala *and* Wazirabad); "My profile location · Wazirabad" (not the account's place); "Demo build: no SMS is sent" (on the connected build a code really is sent). | Reading the running UI after a real sign-in. | Rates title names no district and the badge names the feed; the profile row reads the account's saved label; the note is chosen by the provider, not the build. |
| 7 | **Two React contexts for one module** in the dev server — `/src/location/LocationProvider.tsx?t=…847` in `App.tsx` and `?t=…028` in `HomeScreen.tsx` — so the provider mounted and the hook saw a different context, and the app rendered nothing. | Fetching the *transformed* modules and comparing the import URLs; captured from a fresh incognito tab so it could not be HMR noise. | Dev-server restart (stale transform cache). Not a product defect, but recorded because it looked like one. |

---

## 2 · Database and authorization — live project evidence

Applied and verified in the live project (not from local files):

- **Migrations 0018, 0019, 0021, 0022 applied.** `ai_knowledge_search`, `ai_product_for_knowledge`,
  `otp_challenges`, the Open-Meteo provider row, the knowledge seed, party provisioning, the guest-safe
  radius search, the saved-location RPCs, and the reference data set.
- **Seed state:** 3 canonical products · 7 published knowledge entries · 7 index rows · 6 dealers ·
  10 listings · 5 market observations · 1 weather provider row.
- **Provisioning proven on a brand-new user** (not just the backfill): inserting one `auth.users` row
  produced a party (`kind=farmer`, display name from metadata), a `farmer_profiles` row, a
  `farmer_search_settings` row (radius 10) and a verified primary phone contact.

Authorization, exercised as real roles with real JWT claims:

| Caller | Call | Result |
|--------|------|--------|
| `authenticated` | `current_party_id()` | resolves the party from the session (`b0da419c-…`), not from an argument |
| `authenticated` | `farmer_location_save(...)` | writes; read-back returns the label, coordinates, source and `set_at` |
| `authenticated` | `select * from farmer_profiles` | only the caller's own row |
| `authenticated` | `dealers_within_radius(null,null,null,null)` | 3 dealers, `used_temporary_area = false`, radius 25 from the farmer's own settings |
| `anon` | `farmer_location_save(...)` | refused: `42501 Sign in to save a location.` (raised inside the function — grants alone are not the guarantee) |
| `anon` | `farmer_location_get()` | 0 rows — "nothing saved", not an error |
| `anon` | `dealers_within_radius(null, 32.443, 74.115, 10)` | 2 dealers — the guest path answers |
| `anon` | `dealers_within_radius(null,null,null,10)` | `P0002 No search origin…` — "we do not know where you are" is not "there is nothing near you" |

Also verified: OTP window raised from the hostile 60 s default to **300 s expiry / 60 s resend**
(`sms_otp_exp`, `sms_max_frequency` via the Management API) so the client countdown matches what the
server enforces.

---

## 3 · Guest → authenticated, in the browser

Run against `http://localhost:5174` with the real project, then read back from Postgres.

**Before login (guest)**

- Home: live weather (28°, humidity 73%, wind 4 km/h, "Source: Open-Meteo"), mandi rates from the
  `research_feed` source, 2 dealers within 10 km.
- Dealers: "Your location — **Not saved yet** — The default area for your district until you save one."
  Choosing Gujranwala switches the list to Gujranwala shops and says
  "Searching around Gujranwala. Your saved location stays Not saved yet." with a **Save this location**
  control.
- Nothing about reading requires an account.

**The transition**

1. Tapping **Save this location** opens the gate with the location's own reason: "Sign in so this
   location can be saved to your account. Your search stays where it is." The chosen area is still there.
2. Number `03001234567` → Continue → Supabase Auth accepts the send (the app shows the code step and a
   resend countdown, not an error).
3. Code `123456` → Verify → the pending action runs, the toast fires, and the bar becomes
   "Gujranwala — Saved to your account."

**After login — read back from the database**

```
label: Gujranwala   lat: 32.1877   lon: 74.1945   source: profile_entry   radius: 10
parties: 2          farmer_profiles: 2        (no duplicate account was created)
```

**Persistence:** a full page reload restores the session from the stored refresh token, re-reads the
saved location from the server, and Home again shows Gujranwala with the Gujranwala dealers 1 km and
3 km away.

### Per-screen matrix

| Screen | Guest sees | Signed in sees | Source | What changes | Needs auth |
|--------|-----------|----------------|--------|--------------|------------|
| Home | Weather for the default or temporary area, rates, 2 nearest dealers, crops/credit from the device document | Same, but weather + dealers for the **saved** location, and the account's document from `client_document_get` | `latest_weather`/Open-Meteo, `market_rates`, `dealers_within_radius` | The location the reads are about, and where the document is read from | No |
| Dealers | Search anywhere, labelled temporary; "Not saved yet" | Saved location used by default; temporary searches still allowed; Save writes to the account | `dealers_within_radius` (+ saved location when no origin) | The Save control becomes an account action instead of a gate | Only to **save** |
| Scan | Full diagnosis + stockists | Same, attributed to the party in the AI `Authorization` header | `ai` Edge Function + `dealer_stockists_for` | Whose history the answer belongs to | No |
| Chat / Community / Credit / Visits | Read; posting, replying, messaging, credit and visits are gated | Full participation, persisted per account | `client_documents` (owner-scoped, RLS) | Writes become possible | Yes |
| Profile | Device document | Account document + saved location | `client_document_get`, `farmer_location_get` | Own data follows the account | Yes |

---

## 4 · Regression suite

| Check | Command | Result |
|-------|---------|--------|
| Typecheck | `npx tsc --noEmit` | clean |
| Unit + integration | `npx vitest run` | **278 passed, 1 skipped, 25 files** (was 260/1) |
| Design system | `npm run lint` | "no token bypasses, no physical direction utilities" |
| Migrations | `npm run lint:migrations` | 22 files · 56 tables · 56 with RLS |
| Edge Functions | `npm run lint:functions` | 4 functions, client routes checked |
| Android build | `npm run apk` | `BUILD SUCCESSFUL` — `artifacts/farmer-app-debug.apk`, 9.5 MB |

New tests this pass: `location.test.ts` (13), `supabaseClient.test.ts` (5), `App.location.test.tsx` (4).
The last one is the rule stated as behaviour: a guest's search stays temporary and unsaved, the Save
control asks for an account, and declining writes nothing.

---

## 5 · Genuine remaining blockers

1. **Real SMS is not deliverable yet.** Supabase phone auth is enabled with Twilio as the provider, but
   the project has no Twilio credentials, so only the configured test number receives a code. A real
   number returns a provider error, which the sheet now shows in the provider's own words rather than
   as a network failure. *Owner action: add Twilio credentials to the Supabase project.*
2. **Analytics key is not in the deployed bundle.** `.env.local` does not define `VITE_ANALYTICS_KEY`, so
   the local build has no key by design (`phc_` count in `dist`: 0). The Vercel production variable
   exists but has not appeared in a built bundle across three deploys. *Owner action: confirm the Vercel
   variable is type **Config** (not Secret) and that "include in build" is on; never paste it in chat.*
3. **Market relevance is not district-filtered.** `market_rates()` takes no location, and the saved
   location stores a label but no district, so rates are "latest per mandi" nationally. Making market
   relevance real needs a `district` on the saved location and a district argument on `market_rates`.
4. **Credit, visits, moderation, messaging and community still persist through the owner-scoped document
   store** (`client_document_*`) rather than the domain tables. Persistence, isolation and reload behave
   correctly and are covered by tests, but the PRD's server-side state machines for those workflows
   (single counteroffer, expert verification, moderation transitions) are **not yet enforced by the
   domain tables**. This is the largest remaining engineering item and it is not presented as done.
5. **Vercel production still serves the previous build** — this work is uncommitted and unpushed by
   design (no commit was requested).
6. **The APK is build-verified, not run-verified:** no emulator or device is available here, so the
   artifact was checked for a successful build, correct size and the baked production Supabase URL.
7. **Housekeeping:** the Vercel API token pasted in chat earlier still needs revoking;
   `docs/CREDENTIALS-REQUIRED.md` is stale and still claims everything is disconnected.

---

## 6 · Where the AI boundary stands

- Gemini is live and proven (`GET /functions/v1/ai/health` → `configured:true, active:"gemini"`).
- Retrieval is keyword-only and says so: `ai_knowledge_search` returns `used_embedding = false`.
- The evidence chain is real data, verified live:
  `ai_product_for_knowledge('cotton-pink-bollworm')` → *Confidor (imidacloprid)*, `DPP-PK-2017-0212`,
  **3 dealers listing it** — a diagnosis reaches a shop only through a product the knowledge entry names,
  never because a shop happens to have stock.
- Prices, availability and dealer verification are read from the normalised tables or reported as
  unknown; nothing is invented, and NULL is never rendered as 0.
