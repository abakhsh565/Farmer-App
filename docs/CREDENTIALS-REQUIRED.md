# Credentials and access required

Everything that could be built without external accounts has been built. This is
the single consolidated list of what now genuinely requires you, because it is a
key, an account, or a business decision that only you can supply.

Nothing here is a question about product behaviour — those decisions are taken
from the PRD and are already implemented.

## How to read this

- **Blocks the backend** means the 17 migrations in `supabase/migrations/` cannot
  be applied, so the app runs on its local development providers and the device's
  own storage instead of the real services.
- **Blocks one integration** means the surrounding architecture, schema, adapter
  interface and retention rules exist; only the provider is missing.
- Values go in `.env.local` (git-ignored). `VITE_*` values are inlined at build
  time, so the APK must be rebuilt after they change — `npm run apk`.

---

## 1. The table

| Service | Why needed | Exact credential / access | Where it will be used | Required for |
| --- | --- | --- | --- | --- |
| **Supabase project** (dedicated to the farmer app) | The whole backend — schema, RLS, RPCs, storage, jobs — has nowhere to live | Project ref, `Project URL`, `anon` (publishable) key, `service_role` key, and the database password | `.env.local` → `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`; service role only in Edge Functions and CI, never in the app bundle | **Blocks the backend.** Applying migrations, real auth, real persistence |
| **WeatherAPI.com** | Live weather instead of a fixture; the PRD names it as the initial MVP candidate | API key (free tier is enough to start) | `weather_readings` ingestion adapter, run on a schedule; read by UI and AI through the same normalised service | Weather in UI and in AI advice |
| **AMIS Punjab market data** | Real mandi rates. The PRD forbids inventing an AMIS key, so this needs the real thing | Feed endpoint and/or registered credentials, or your written approval of a named alternative source | `market_observations` ingestion adapter → the internal `market_rates()` API | Market rates |
| **SMS / OTP provider** | The sign-in *machine* is built: request a code, enter it, verify, with expiry, a resend cooldown, an attempt lockout and a distinct sentence for each failure — all driven through the real `OtpProvider` contract and covered by tests. What is missing is the sender, so in development the code is printed on the sheet and labelled as a development build. Without a provider there is no proof of possession of the number | Provide name, e.g. Twilio or a Pakistani aggregator: account SID, auth token, sender/mask ID, plus a template approved for Urdu | The verification Edge Function that sends and checks the code; the client already calls it through `VITE_OTP_ENDPOINT` | Real authentication, and the "verified identity" precondition for expert verification |
| **Firebase Cloud Messaging** | Push delivery. The PRD's notification requirement is not satisfied by an in-app list | `google-services.json` for Android, plus a service account JSON for server-side sends | `notification_events` dispatch Edge Function; `google-services.json` into `android/app/` | Real notifications |
| **AI / LLM provider** (OpenAI or your choice) | The agricultural assistant and the scan diagnosis. Agricultural-only, knowledge-grounded | API key, plus the model name you want to standardise on | Scan and chat Edge Functions; prompts restricted to published `agri_knowledge_entries`; also embeddings for `agri_knowledge_index` | AI chat, scan diagnosis |
| **PostHog** | Analytics and instrumentation are a PRD deliverable and are not built | Project API key and host (self-hosted or cloud) | Client events and the ingestion/sync observability hooks | Analytics, product measurement |
| **Dealer business system access** (your Agri Shop POS) | The PRD makes the dealer system the source of truth for products, stock, availability and dealer status, with the farmer app as a read-facing projection | Read-only database connection string or a REST endpoint plus a token for the POS project | The dealer sync job that populates `dealer_profiles`, `dealer_products` and writes `dealer_sync_runs` | Real dealer search, real stock and price |
| **Maps / geocoding provider** (optional but recommended) | Turning a device location into a readable area name; today `location_label` is seeded | Google Maps API key, or an alternative geocoder | Location labelling on profile and dealer search | Location onboarding, area labels |
| **Android release signing** | A debug APK installs but cannot be published or upgraded in place | Keystore file, key alias, keystore and key passwords | `android/app/build.gradle` `signingConfigs.release` | Play Store release, upgradeable installs |

---

## 2. Two decisions I need from you

These are not credentials, but I will not guess them.

**a. Which Supabase project should hold the farmer backend?**

I inspected both existing projects read-only and stopped there, because both hold
real data:

| Project | What it actually is | Rows seen |
| --- | --- | --- |
| `gkswcfljxlutkfdvvqng` — "Agrishop APp" | The **live shop-owner POS**: sales, sale items, customers, payments, notifications | 52 sales, 57 sale items, 6 customers, 20 payments, 51 notifications |
| `bpybjrjenwccowvtrevu` — "Agri-shop-App-QA" | The **engineering memory database**: incidents, agent tasks, 64 engineering lessons, 1200 impact analyses | 1200 impact analyses, 64 memories, 5 incidents |

Neither is a farmer-app backend. Per the PRD the POS *is* the dealer source of
truth, so it stays read-only to this app. My recommendation is a **third,
dedicated project** for the farmer schema, which keeps the POS untouched and lets
the dealer sync be a genuine cross-system read.

**b. Is the live POS the right dealer source, or should the sync read QA first?**

Pointing the projection at production data from day one means a farmer can phone a
shop about stock that is real. Pointing it at QA means the shop cannot be
embarrassed by a sync bug. My recommendation is QA first, then production once the
sync has run clean for a week.

---

## 3. What happens the moment these arrive

No redesign, no restart. In order:

1. `supabase db push` the 17 migrations to the chosen project; confirm the
   security advisors report no table without RLS. No client change is needed for
   this step — the schema is what the remote providers already read.
2. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` and rebuild. That single
   flag switches persistence, weather, market and dealers from the development
   providers to the real backend together, deliberately: they are all reads of the
   same normalised data, and having one remote and another local would let the app
   contradict itself about the same fact. Nothing in a screen or a store changes —
   they are already on the repository boundary.
3. Deploy the Edge Functions: AI gateway, weather ingest, market ingest, dealer
   sync, notification dispatch, media processing.
4. Run the RLS test pass — one farmer attempting to read another farmer's credit
   request, one guest attempting to write, one dealer attempting to accept a visit
   they were not asked for. Each must fail.
5. Re-walk the twelve end-to-end flows from the brief against the real backend.
6. `npm run apk` again, and hand you an APK that is genuinely wired to the
   backend rather than running on the development providers.
