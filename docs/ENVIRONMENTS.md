# Environments

Three environments, three databases, three branches, three site URLs, three
update channels. A farmer installs one build and it stays on its own environment
for the rest of its life.

**This page is the explanation. The table is `release/environments.json`** — the
one machine-readable list of which branch, site id, site URL, update channel and
project belong to each environment. `scripts/release-site.mjs`,
`scripts/verify-release.mjs` and the release workflow read that file; nothing
restates it in code. If a value here ever disagrees with it, the file is right and
this page is out of date.

One distinction the file makes and this page used to blur: the **dev site is a
mirror**, not a fourth test environment. It is a static copy of the dev branch for
looking at layout, built against whatever `.env.local` held, so it is never
evidence that data works. Staging is where a build is proven.

| | Branch | Site | OTA channel | App | Database |
|---|---|---|---|---|---|
| **Development** | `development` | https://farmer-app-dev-97xtwn.freebuff.site | `ota-dev` | Farmer Dev (`pk.agrishop.farmer.dev`) | this machine (Docker) |
| **Staging** | `staging` | https://farmer-app-staging-i1iih6.freebuff.site | `ota-staging` | Farmer Staging (`pk.agrishop.farmer.staging`) | `zmyvkwijloqylvftvhvq` |
| **Production** | `main` | https://farmer-app-production-8sc6a2.freebuff.site | `ota-production` | Farmer (`pk.agrishop.farmer`) | `swmbmtvwgksicfnfsehg` |

The three Android packages are separate ids, so all three install side by side on
one phone and a tester never has to uninstall the app to try the next one.

## Which database each build reads

The choice is made in **one place**, `src/services/appEnvironments.ts`, keyed by
`VITE_APP_ENV` — the same value that names the OTA channel, the APK flavour and
the AgriShop project the shop and chat are read from. Nothing else in the code
knows an environment by name.

| `VITE_APP_ENV` | Backend | Where the credentials come from |
|---|---|---|
| `dev` | the developer's own machine | `VITE_SUPABASE_*` in `.env.local` |
| `staging` | staging project | the table in `appEnvironments.ts` |
| `production` | production project | the table in `appEnvironments.ts` |
| `test` | none | nothing — the suite must never reach a database |
| *(unset)* | none | nothing — an unlabelled build must not pick a live database |

Two rules are worth stating, because they are what make three environments safe
rather than merely different:

- **The table wins for staging and production, whatever is in `.env.local`.** A
  developer's `.env.local` points at their local stack. If an explicit
  `VITE_SUPABASE_*` could override the table, a staging build made on that
  laptop would talk to a localhost database, and a production build made by CI
  (where there is no `.env.local` at all) would have no backend. Only `dev`
  consults the environment file, because dev's backend is by definition the
  developer's own.
- **The committed keys are publishable keys.** They ship inside every installed
  app by design and grant nothing on their own: every table behind them is
  guarded by row level security that checks `auth.uid()`. The service-role key
  and the `sb_secret_…` key are never in this repository, in a build, or on a
  phone. They live in `.secrets/` locally and in the Supabase dashboard
  otherwise.

## Development — on this machine

Development has a real Postgres, on your own computer, in Docker. Not a cloud
project and not a mock: the same migration chain, the same 92 tables, the same
row-level policies, the same RPCs. That is what makes "it worked locally" mean
something.

```bash
npm run stack:start     # first run pulls images; later runs take seconds
npm run stack:stop      # when you are done for the day
npm run stack:reset     # drop the database and re-apply every migration
```

`npm run verify:environments -- --dev` then signs in with the fixed code below
and does a document round trip against it — the same check staging gets.

`stack:start` prints the local API URL and keys. They are already written into
`.env.local`, which is git-ignored:

```
VITE_APP_ENV=dev
VITE_SUPABASE_URL=http://127.0.0.1:54421
VITE_SUPABASE_ANON_KEY=<the local stack's anon key>
```

The ports are deliberately **not** the CLI defaults (`54321`–`54327`): another
Supabase project on this machine already uses those, and two stacks cannot share
a port. Ours are `54421` (API), `54422` (Postgres), `54423` (Studio), `54424`–
`54426` (mail), `54427` (analytics); see `supabase/config.toml`.

What that buys:

- **Nothing leaves the machine.** No test row, no test farmer and no half-built
  migration ever reaches a shared project. `npm run stack:reset` empties it.
- **The migration chain is exercised on every reset.** A migration that cannot
  apply to an empty database fails on your laptop, not in staging.
- **Studio** at http://127.0.0.1:54423 for looking at the rows.

With the stack down the app still opens and works from the phone's own storage —
the document layer is built for exactly that — but screens that need the server
say they are not syncing. Start the stack before judging a data screen.

The dev APK is the one place localhost means the phone itself. Install it only
for UI work, or run `adb reverse tcp:54421 tcp:54421` so the phone reaches the
stack over the cable. Everything that touches data is tested on the staging
build, which is the whole point of having one.

## Staging — `zmyvkwijloqylvftvhvq`

Built from the migration chain, not copied from production: `supabase/apply-all.sql`
was applied to an empty project, which is the rehearsal that proves the chain can
still build an environment from nothing.

| | |
|---|---|
| Project | https://supabase.com/dashboard/project/zmyvkwijloqylvftvhvq |
| Tables / RLS / policies | 92 / 92 / 94 — identical to the chain |
| Edge Functions | all 10 deployed (`ai`, `otp`, `notify-shop-owner` and the six ingest functions) |
| Secrets | `FCM_SERVICE_ACCOUNT`, `FCM_PROJECT_ID`, `SHOP_PUSH_TOKEN`, `INGEST_TOKEN` |
| Vault | `ingestion_project_url`, `ingestion_project_ref`, `ingest_gateway_key`, `ingest_token`, `shop_push_token` |
| Storage buckets | `scan-media`, `voice-notes`, `community`, `verification`, `report-media` |
| Scheduled jobs | the 20 from the chain (retention, expiry, refresh, ingestion) |
| Content | production's readings, forecasts, observations, rules and market rows — **not** its people |

### Signing in on dev and staging

Neither has an SMS provider, so a real code cannot be delivered. Supabase has a
supported answer for that: a fixed test OTP, configured per project and per local
stack.

```
923001234567   code 123456
923001111111   code 111111
```

Dev gets them from `[auth.sms.test_otp]` in `supabase/config.toml`; staging from
`sms_test_otp` on the project. Production carries only the first number, so two
test farmers cannot be signed in against live data.

That is configuration on the project (`sms_test_otp`), not a code path in the
app: the app still calls `signInWithOtp` and `verifyOtp`, and the session it gets
back is a real one, so every row-level policy applies exactly as it does in
production. Production does not carry the second number, and neither project
carries a test OTP for any other number.

## Production — `swmbmtvwgksicfnfsehg`

The project every installed production app already talks to, which is why
splitting the environments needed no data migration and no reinstall.

| | |
|---|---|
| Project | https://supabase.com/dashboard/project/swmbmtvwgksicfnfsehg |
| Region | `ap-southeast-1` |
| Auth | phone + email, `sms_test_otp` for `923001234567` only |

It carries a **legacy community block** that this client never calls: 17 tables
(`community_*`, `dealer_messages`) and 46 functions (`community_*`,
`dealer_send_message`) from the design before community content moved into
`client_documents`. The app's remote surface — `client_document_*` plus the RPCs
listed in `src/services/**` — is present in the chain, and the chain is what new
environments are built from. Staging therefore does not have that block: it has
the surface the client actually uses.

That is a deliberate difference, not drift to be copied. The follow-up, when the
shop team touch that area, is one migration that either owns those objects or
drops them from production — not a copy into every new environment.

## What is never copied between environments

- **People.** `auth.users`, `parties`, `client_documents`, `device_push_tokens`
  and `audit_log` are per-environment. A staging database carrying production's
  users is a second copy of personal data with weaker protection.
- **Push registrations.** A token belongs to one install of one app id; copying
  it would send one environment's notification to another environment's phone.
- **Secrets.** Each project has its own Edge Function secrets and its own Vault.
  The values are the same where they *are* the same thing (`SHOP_PUSH_TOKEN` is
  one shared secret between the trigger and the function, inside one project),
  and different where the thing is different (the ingestion project URL, the
  gateway key, the ingest token).

## Promotion

```
development ──merge──▶ staging ──merge──▶ main
     │                    │                  │
   ota-dev            ota-staging       ota-production
```

Nothing promotes by itself. A commit on `development` stays off staging until it
is merged, and each merge is what republishes that environment's OTA bundle. The
sequence, and what proves each step:

1. **On `development`** — `npm run check:fast` (type check, design conformance,
   unit tests) against the local stack. Nothing leaves the machine.
2. **Merge into `staging`** — CI runs the full suite, the migration chain lint,
   the Edge Function contracts, the recovery drill and the load check; the merge
   publishes `ota-staging`; the staging APK picks it up on next launch.
3. **Verify on staging** — `npm run verify:environments -- --staging` signs in as
   a farmer and does a document round trip, including a second farmer who must be
   refused. This is the check that a release actually works against a real
   database.
4. **Merge into `main`** — the same gates, then `ota-production`. Production
   phones update themselves.

## What happens on a push

- **CI** (`.github/workflows/ci.yml`) — type check, design conformance, migration
  chain, Edge Function contracts, the full test suite, a production build, the
  backup/restore drill and the bounded-load check. Runs on `main` and on pull
  requests.
- **OTA bundle** (`.github/workflows/ota.yml`) — builds the web layer for that
  branch's environment, packs it and publishes it to the matching release tag.
  An installed app on that channel picks it up on its next launch.

The OTA workflow needs **no Supabase secret**. The backend is chosen from
`VITE_APP_ENV` by the table, so a bundle carries the right project because it was
built for that branch — not because CI was told which URL to use. The one secret
it still reads is the analytics key.

## Installing and updating

- **First install** is an APK: `npm run apk:dev`, `apk:staging`, `apk:production`.
  Each is a separate package id, so all three live side by side.
- **Every update after that is OTA.** The installed app polls its channel's
  `latest.json` on launch, downloads the bundle only when the id differs, verifies
  the checksum and reloads. Nothing is reinstalled, and a failed download leaves
  the bundle inside the APK running.
- **What OTA cannot change** is the native shell: a new plugin, a permission or a
  launcher change still needs an APK. The web layer — screens, logic,
  configuration, *including which database to talk to* — does not.

That last point is why the environment table travels in the bundle: an app
installed as staging before the split resolves the staging project after its next
OTA update, with no reinstall.

## Database automation

`.github/workflows/db-sync.yml` runs on every push to the three branches:

- **alignment** — every branch, read-only. `scripts/check-db-alignment.mjs`
  requires every RPC the code calls to exist in the migration chain (or to be a
  known AgriShop call served by a shop project), and every `VITE_*` the code
  reads to be documented in `.env.example`. A push that calls a function nobody
  migrated fails here, rather than at runtime on a phone.
- **migrate** — `staging` and `main` only. `supabase db push` against that
  branch's own project, `--dry-run` first.

It is deliberately inert until the owner configures it, because a workflow that
can alter a database should not start doing so merely because a branch was
merged:

| Where | Name | Value |
|---|---|---|
| Secret | `SUPABASE_ACCESS_TOKEN` | a dashboard access token |
| Variable | `STAGING_SUPABASE_PROJECT_REF` | `zmyvkwijloqylvftvhvq` |
| Variable | `PROD_SUPABASE_PROJECT_REF` | `swmbmtvwgksicfnfsehg` |

Without them the migrate job prints a warning and applies nothing — it does not
fail, because a missing credential is a setup step, not a broken branch.

One thing to know before enabling it: both projects were built by applying
`supabase/apply-all.sql`, not by the CLI, so their
`supabase_migrations.schema_migrations` table has been stamped with the 72
versions the chain already contains. That is what makes the first `db push` a
no-op instead of an attempt to create 92 tables that already exist.

## What is not automatic

- **The website upload.** Building and packaging are automated:
  `npm run release:site -- --env <env>` produces `deploy-site/` and records exactly
  what it contains in `release/<env>.json`. The upload is one `sites_deploy` call
  with that manifest, because hosting credentials are deliberately not in this
  repository. `npm run verify:release -- --env <env>` then proves the live site
  serves the recorded bundle; `--strict` makes a missed upload fail a production
  gate. There is no second build path and no `dist-<env>` / `web/` manifest any
  more — those were two ways to do one thing.
- **iOS.** The project exists and builds the same web assets, but it needs macOS,
  Xcode and an Apple Developer account. Until then the iOS path is the PWA.
- **Production chat.** The production AgriShop project has not published the
  `farmer_api_*` functions, so a production build shows the shop and its listings
  but cannot hold a conversation. Staging works because the staging AgriShop
  project has published them.

## Open items

Carried over from the first pass at this separation, and still open:

- **AgriShop migrations 0325–0333** exist in the shop repository but are not
  applied to either shop project; applying them is the shop team's call.
- **Vercel** still needs the Farmer App project re-authorised before
  per-environment variables can be set there. The three `freebuff.site` URLs are
  unaffected.
- **`GEMINI_API_KEY`** behind the Urdu voice is a server-side secret set per
  deployment. It is not a `VITE_` variable and never ships in a bundle.
- **Rows that predate the split.** `swmbmtvwgksicfnfsehg` still holds the two
  accounts and the documents created while every environment shared it. Nothing
  in this setup deletes them — that is the owner's decision.
