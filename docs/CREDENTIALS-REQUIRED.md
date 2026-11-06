# Credentials and access required

Everything that could be built without external accounts has been built. This is
the single consolidated list of what now genuinely requires you, because it is a
key, an account, or a business decision that only you can supply.

Nothing here is a question about product behaviour — those decisions are taken
from the PRD and are already implemented.

## How to read this

- **Blocks the backend** means the 30 migrations in `supabase/migrations/` cannot
  be applied, so the app runs on its local development providers and the device's
  own storage instead of the real services.
- **Blocks one integration** means the surrounding architecture, schema, adapter
  interface and retention rules exist; only the provider is missing.
- Values go in `.env.local` (git-ignored). `VITE_*` values are inlined at build
  time, so the APK must be rebuilt after they change — `npm run apk`.

---

## 0. Status after this round

> **2026-10-04 — all external connections were removed at the owner's request.**
> The table below is kept as a record of what was verified before withdrawal.
> Nothing here is currently connected except the weather service. No project ref,
> URL, key or token is recorded in this repository any more.

| Service | What was done | Evidence |
| --- | --- | --- |
| **Supabase project** | Configured and verified, then **disconnected on 2026-10-04** | The dedicated Farmer App project (ref no longer recorded here) resolved, and its publishable key authenticated (`auth/v1/settings` → 200, `storage/v1/bucket` → 200, and a missing table answered 404 rather than 401). The project is **empty** — no tables, no buckets, no functions — and remains untouched in the owner's dashboard. Every Supabase value was deleted from `.env.local`; no credential of any kind remains on this machine. |
| **GitHub** | Repository created and pushed, then **disconnected on 2026-10-04** | The private repository exists under the owner's GitHub account. At the owner's request the CLI token was logged out of this machine and the local `origin` remote removed. The repository itself can be deleted from GitHub settings if unwanted. |
| **Weather (Open-Meteo)** | Live and verified | Keyless. The client reads it directly, and `weather-ingest` stores the same numbers in `weather_readings`. Verified against the real service: Wazirabad 30.9 °C, feels 36.5, 66 % humidity, observed `2026-10-03T12:15:00Z`. |
| **Key hygiene** | Checked, not assumed | No key *value* ever entered git history — only key-format prefixes appear in prose, as linter patterns. On 2026-10-04 every Supabase value was removed, the bundle and Android assets were regenerated, and the APK was rebuilt with **no backend configured**: it contains no project URL and no key. |
| **Edge Functions** | Written, not deployed | `supabase/functions/{ai,otp,weather-ingest}` with `_shared/`. `npm run lint:functions` verifies the routes the client calls are the routes the functions handle, and that no secret is inlined into a source file. |

### What is left on the Supabase side

Three things, and only the first blocks the backend.

**1. Apply the schema — the migrations are not in the project.**

Measured against the live database, not assumed. Every probe returns 404:

| Probe | Result |
| --- | --- |
| `GET /rest/v1/parties?select=id` | 404 |
| `GET /rest/v1/farmer_profiles`, `crop_catalog`, `canonical_products`, `weather_readings`, `otp_challenges`, `dealer_profiles`, `client_documents` | 404, all of them |
| PostgREST OpenAPI at `/rest/v1/` | **1 path** — i.e. no tables exposed at all |
| `GET /functions/v1/{ai,otp,weather-ingest}/health` | 404 — no function deployed |
| `GET /storage/v1/bucket` | `[]` — no buckets |

So the SQL was either run against a **different project** (a different account's
dashboard, or one of the other two projects) or the run failed and was rolled
back. The bundle is a single transaction by design, so a failure anywhere rolls
back every statement and leaves no partial schema — which is exactly what an
empty database looks like.

**To find out in one step:** open the SQL editor of the project you ran it in and
execute `select count(*) from pg_tables where schemaname = 'public';`.

- **64** → it landed somewhere else; send that project's ref and I will point the
  app at it instead.
- **0 or an error** → it did not land. Run the file again in
  the project's SQL editor and send me the first error, if any.

Applying it needs a credential I do not have and cannot obtain from here. Two
were tried and both failed for the same reason — a PostgREST key is not a
database credential:

```
db push --db-url postgresql://postgres:<secret key>@db.<ref>.supabase.co:5432
  → hostname resolving error (db.<ref>.supabase.co does not resolve)

db push --db-url postgresql://postgres.<ref>:<secret key>@aws-0-ap-northeast-1.pooler.supabase.com:5432
  → FATAL: tenant/user postgres.<ref> not found (SQLSTATE XX000)
```

- **The database password** (Dashboard → Project Settings → Database → Reset database password), or
- **An `sbp_…` personal access token** (Dashboard → Account → Access Tokens), or
- **You paste the file yourself**: Dashboard → SQL Editor → paste all of `supabase/apply-all.sql` → Run. This needs no credential sharing at all and takes about a minute.

The secret key you sent is a *PostgREST* key. It is not a database credential and
cannot execute DDL — which is why the schema is still unapplied.

**2. Deploy the functions.** They need a CLI login or a paste into the
dashboard's function editor.

```
supabase functions deploy ai otp weather-ingest market-ingest climate-ingest advisory-ingest forecast-ingest soil-ingest
```

Each one states in its own header what it will not do without a source — a
missing feed or key is a failed run recorded in the database, never a silent
empty table.

**3. Set the function secrets.** `OPENAI_API_KEY` (rotated — see below) or
`GEMINI_API_KEY`, `OTP_HASH_SECRET` (any long random string), and
`OTP_DELIVERY_URL` + `OTP_DELIVERY_TOKEN` once an SMS provider exists. For live
mandi rates, `AMIS_FEED_URL` (+ `AMIS_FEED_TOKEN`) or `MARKET_FEED_URL`.

The district forecast now defaults to **keyless Open-Meteo ECMWF IFS** in
`forecast-ingest`, because that is the provider/model the Layyah calibration was
trained on. No `WEATHERAPI_KEY` is needed for that path. WeatherAPI remains an
explicit alternative (`provider=weatherapi`) and still starts a recorded failed
run if its key is missing.

The AI gateway supports **both** OpenAI and Gemini. `AI_PROVIDER` chooses one
(`openai` or `gemini`); with it unset, whichever key is present wins, OpenAI
first. `GET /functions/v1/ai/health` reports which providers are configured and
which one is active — booleans and names only, never the key.

Two settings worth knowing, both currently off and neither blocking:
`auth.external.phone` is `false` (our `otp` function does not depend on it — it
implements phone verification itself), and there are **no storage buckets**, so
media upload has nowhere to go until one is created.

**The OpenAI key was pasted into chat, and a key that has been in a transcript
should be treated as compromised.** Rotate it and set the new one only as the
function secret — never in chat, never in `.env.local`.

---

## 1. The table

| Service | Why needed | Exact credential / access | Where it will be used | Required for |
| --- | --- | --- | --- | --- |
| **Supabase: apply the schema** (see §0) | The project is configured and verified, but has no tables — the 30 migrations have nowhere to land without a DDL-capable credential | One of: the database password, an `sbp_…` personal access token, or a paste of `supabase/apply-all.sql` into the SQL Editor | Nothing client-side — the remote providers already read the schema that this creates | **Blocks the backend.** Real auth, real persistence, real market and dealer data |
| **Open-Meteo ECMWF IFS** (default) | The district forecast and the provider/model used by the trained Layyah bias correction | **No key.** `forecast-ingest` defaults to `provider=open_meteo`; no secret is configured | `forecast-ingest` writes a 7-day horizon to `climate_forecasts`; the active model applies only to `open_meteo` + `layyah` | Weather/forecast risks and the calibrated model. **Licence caveat:** the free tier is non-commercial; commercial deployment needs the paid plan or another licensed source. `intel_sources` records the limitation |
| **WeatherAPI.com** (optional) | Alternative district forecast if a commercial WeatherAPI licence is confirmed | `WEATHERAPI_KEY` and an explicit `provider=weatherapi` request; the free horizon is 3 days | `forecast-ingest` alternative path. It is not selected silently, because the trained ECMWF model must not be applied to a different vendor's raw value | Optional forecast path only. The prior licence ambiguity remains recorded in `intel_sources` |
| **AMIS Punjab market data** | Real mandi rates. The PRD forbids inventing an AMIS key, so this needs the real thing | Feed endpoint and/or registered credentials, or your written approval of a named alternative source | `market_observations` ingestion adapter → the internal `market_rates()` API | Market rates |
| **SMS / OTP provider** | The sign-in *machine* is built and the `otp` function is written: codes are generated from a CSPRNG, stored as HMACs (never plaintext), and limited to 5 sends an hour and 3 attempts a code. What is missing is the sender | Name, e.g. Twilio or a Pakistani aggregator: account SID, auth token, sender/mask ID, and a template approved for Urdu. Set as `OTP_DELIVERY_URL` + `OTP_DELIVERY_TOKEN` on the `otp` function, plus a generated `OTP_HASH_SECRET` | The `otp` Edge Function. **With no provider configured it reports `deliveredVia: "none (not delivered)"` and a `deliveryError`, rather than claiming a code was sent** | Real authentication, and the "verified identity" precondition for expert verification |
| **Firebase Cloud Messaging** | Push delivery. The PRD's notification requirement is not satisfied by an in-app list | `google-services.json` for Android, plus a service account JSON for server-side sends | `notification_events` dispatch Edge Function; `google-services.json` into `android/app/` | Real notifications |
| **AI / LLM provider** (OpenAI or your choice) | The agricultural assistant and the scan diagnosis. Agricultural-only, knowledge-grounded | **A rotated** API key set as the `OPENAI_API_KEY` secret on the deployed `ai` function, plus the model name to standardise on (`OPENAI_MODEL`, default `gpt-4o-mini`) | The `ai` Edge Function, which is written and ready. Prompts are restricted to published `agri_knowledge_entries`; the product a treatment names is read from `canonical_products`, never from the model | AI chat, scan diagnosis |
| **PostHog** | Analytics and instrumentation are a PRD deliverable and are not built | Project API key and host (self-hosted or cloud) | Client events and the ingestion/sync observability hooks | Analytics, product measurement |
| **Dealer business system access** (your Agri Shop POS) | The PRD makes the dealer system the source of truth for products, stock, availability and dealer status, with the farmer app as a read-facing projection | Read-only database connection string or a REST endpoint plus a token for the POS project | The dealer sync job that populates `dealer_profiles`, `dealer_products` and writes `dealer_sync_runs` | Real dealer search, real stock and price |
| **Maps / geocoding provider** (optional but recommended) | Turning a device location into a readable area name; today `location_label` is seeded | Google Maps API key, or an alternative geocoder | Location labelling on profile and dealer search | Location onboarding, area labels |
| **Android release signing** | A debug APK installs but cannot be published or upgraded in place | Keystore file, key alias, keystore and key passwords | `android/app/build.gradle` `signingConfigs.release` | Play Store release, upgradeable installs |

---## 2. The decisions, now answered

**a. Which Supabase project holds the farmer backend?** Answered, then
**withdrawn by the owner on 2026-10-04.** A dedicated project was configured for
the app and stood empty (no tables, no buckets, no functions — a clean slate for
the schema). The owner then removed every connection: the values were deleted from
`.env.local`, the bundle and APK were rebuilt without a backend, and the project
ref is no longer recorded in this repository. It remains untouched and empty in
the owner's dashboard, where it can be deleted if unwanted. Other Supabase
projects belonging to a different account exist in this machine's history; they
hold another system's live data, they were never written to by this app's work,
and their identifiers have been removed from this repository.

**b. Is the live POS the right dealer source, or should the sync read QA first?**
Still open, and it is a business decision rather than a credential. Pointing the
projection at production data means a farmer can phone a shop about stock that is
real; pointing it at QA means the shop cannot be embarrassed by a sync bug. My
recommendation is QA first, then production once the sync has run clean for a week.

---

## 3. What happens the moment these arrive

No redesign, no restart. In order:

1. Apply the 30 migrations — either `supabase db push`, or paste the bundled
   `supabase/apply-all.sql` into the dashboard's SQL editor. Confirm the security
   advisors report no table without RLS. No client change is needed for this
   step — the schema is what the remote providers already read.
2. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` and rebuild. That single
   flag switches persistence, weather, market and dealers from the development
   providers to the real backend together, deliberately: they are all reads of the
   same normalised data, and having one remote and another local would let the app
   contradict itself about the same fact. Nothing in a screen or a store changes —
   they are already on the repository boundary.
3. Deploy the functions that are written — `ai`, `otp`, `weather-ingest`,
   `market-ingest`, `climate-ingest`, `advisory-ingest`, `forecast-ingest` — and
   set the `OPENAI_API_KEY` / `OTP_HASH_SECRET` / `WEATHERAPI_KEY` secrets on
   them. Each ingest function records its own failures, so a function deployed
   without its source is visible in the database rather than silently empty. The
   remaining server components the PRD names (dealer sync, notification dispatch,
   media processing) are not written yet.
4. Run the RLS test pass — one farmer attempting to read another farmer's credit
   request, one guest attempting to write, one dealer attempting to accept a visit
   they were not asked for. Each must fail.
5. Re-walk the twelve end-to-end flows from the brief against the real backend.
6. `npm run apk` again, and hand you an APK that is genuinely wired to the
   backend rather than running on the development providers.
