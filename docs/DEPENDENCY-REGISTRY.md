# Dependency Registry — Farmer App

> **State as of 2026-10-04 (second phase): connections restored at the owner's request — see §6.**
> Supabase (project **Farmer-App**), GitHub and Vercel are connected. The weather API
> (Open-Meteo — keyless) remains live. §1 records the earlier full disconnection, kept for history.
> No key value is recorded anywhere in this repository, by design.
>
> **Status vocabulary:** `CONNECTED` · `READY` · `OWNER ACTION REQUIRED` · `MOCKED` · `BLOCKED` · `VERIFIED` · `DISCONNECTED`

---

## 1. Disconnection log — 2026-10-04

Everything below was done on the owner's instruction. Nothing belonging to any other
account or system was read, written or deleted at any point.

| System | Action taken | How to restore, if ever wanted |
|---|---|---|
| **Supabase (Farmer App backend)** | Every value deleted from `.env.local`; no credential exists in any file or on disk; bundle, Android assets and APK rebuilt with **no backend configured**. The dedicated project in the owner's Supabase account was empty (0 tables, 0 buckets, 0 functions) and remains untouched — the owner may delete it from their dashboard if unwanted. | Create a fresh project key or scoped access token in the owner's Supabase dashboard, fill `.env.example` → `.env.local`, rebuild. |
| **Supabase MCP integration** | Cannot be removed from this side — it is an app-level connector, and no tool exists to disconnect it. **Owner action:** revoke it in Supabase → *Organization settings → Authorized Apps*, and/or disconnect the Supabase connector in this app. | Reconnect deliberately, if ever wanted. |
| **GitHub** | `gh auth logout` — the stored token was removed from this machine. The `origin` remote was removed from the local repository. The repository itself still exists on GitHub (private); the owner may delete it from GitHub settings if unwanted. | `gh auth login`, then `git remote add origin <repository-url>`. |
| **Vercel** | Was never connected — no token, no login, no project link existed. `vercel.json` is an inert config file, not a connection. | Nothing to do; import the repository in Vercel when desired. |
| **Local CLI traces** | `~/.supabase` (traces + telemetry written by this machine's tooling) deleted. | Recreated automatically the next time the CLI runs. |
| **OpenAI · SMS/OTP · FCM · PostHog · AMIS · dealer/POS · maps** | Nothing was ever connected, stored or configured. No key of any of these exists on this machine. | Owner creates the credential in their own account when the feature is built. |
| **Weather (Open-Meteo)** | **Kept — as instructed.** Keyless, no account, no credential. | Already working. |

## 2. What remains connected

| System | Purpose | Required access | Best connection method | Status | Verification evidence |
|---|---|---|---|---|---|
| **Weather — Open-Meteo** | Localised weather, and the same normalised rows the `weather-ingest` function will write | None — keyless, account-free | Direct HTTPS call from the app | `CONNECTED` · `VERIFIED` | Live reading this round: Wazirabad 30.9 °C, feels-like 36.5 °C, 66 % humidity, observed `2026-10-03T12:15:00Z`. `VITE_WEATHER_PROVIDER=open-meteo` is the only setting in `.env.local`. |

Everything else is `DISCONNECTED` (see the log above) or `MOCKED` and local-only:
AI answers, OTP delivery, market data, dealer data, analytics and push all run on
development providers behind the production-compatible contracts already in the code.
None of them makes a network call in this state.

## 3. Where the code stands

- The app builds and runs with **no backend**: typecheck, lint gates, the migration
  and function checks, the full test suite and the APK build all pass in this state.
- `supabase/migrations/` (19 files) and `supabase/functions/` (4 functions) remain in
  the repository as reviewed source. They are **not applied and not deployed** — no
  project is connected to receive them.
- `.env.example` documents every setting the app *can* accept, with empty values.

## 4. Security rules (unchanged)

1. Only publishable/anon values may ever appear in `VITE_*` — they ship inside the APK.
   Secret keys, service-role keys and vendor tokens belong to the server only.
2. No key value is recorded in this repository. Only key *format prefixes* appear, in
   prose, as patterns for the linter (`scripts/check-functions.mjs`).
3. Any credential the owner creates in future should be stored in the owner's own
   dashboard or a file outside this repository — never pasted into chat, never committed.

## 5. Owner actions outstanding

- **Vercel token hygiene:** a Vercel API token was pasted into chat during setup on 2026-10-04.
  Revoke it in Vercel → Account Settings → Tokens. The CLI session carries its own credentials;
  the pasted token was used once, read-only, and is not stored in this repository or in the app.
- **Optional:** revoke the old Supabase MCP integration (see §1, row 2).
- **Optional:** delete the duplicate Vercel projects `farmer-app-for-pakisan` and
  `farmer-app-for-pakisan-2026` if they are not wanted.

## 6. Reconnection log — 2026-10-04 (second phase)

Per the owner's explicit instruction, the backend, code host and hosting were reconnected on
the same day as the disconnection. This section supersedes §1 wherever the two disagree.

| System | What is connected now | Notes |
|---|---|---|
| **Supabase** | Project **Farmer-App** (`swmbmtvwgksicfnfsehg`, region `ap-southeast-1`), reached through the `supabase-new` connector, which is scoped to that one project. | Schema build in progress: all 19 migrations queued, 3 applied at the time of this entry; then the knowledge seed and the 4 edge functions. The agent fetches the project's publishable key from the connector; the app receives only that key, through `.env.local`, which is git-ignored. |
| **GitHub** | Repository **`abakhsh56/Farmer-App`** (private), branch `main` pushed with full history. | Future commits are authored as the owner's GitHub identity (`Allah Bakhsh <58393098+abakhsh56@users.noreply.github.com>`) so that Vercel accepts them on the free plan. |
| **Vercel** | Project **`farmer-app`**, production alias **https://farmer-app-one-omega.vercel.app**. The GitHub repository is connected — pushes to `main` deploy automatically. Env var `VITE_WEATHER_PROVIDER=open-meteo` is set for Production. | The first Git-triggered deployments were briefly *Blocked* because the commit author (an agent address) was not a member of the Vercel team. Fixed the free way — author commits as the owner's GitHub identity. No Pro upgrade and no collaborators required. |
| **Weather (Open-Meteo)** | Unchanged — keyless, live in both the local preview and the deployed site. | — |
| **AI model gateway** | Gemini key set as a Supabase function secret (activates when the `ai` function is deployed). The `ai` function now also honours `OPENAI_BASE_URL`, so any OpenAI-compatible gateway — e.g. **OmniRoute** — can serve the app by changing one secret and setting `OPENAI_MODEL=auto`. | OmniRoute runs locally for development on `http://localhost:20128/v1` (keyless `auto` model). For deployed functions to use it, the gateway must be hosted somewhere reachable from Supabase's cloud; Gemini remains the zero-extra-parts default. |

`OTP/SMS`, `push`, `analytics`, `dealer/POS` and `maps` remain `MOCKED` behind the
production-compatible contracts, exactly as described in §2. The AI paths are gateway-ready:
they switch to the real model as soon as the functions are deployed, with either Gemini or
an OpenAI-compatible gateway behind `OPENAI_BASE_URL`.
