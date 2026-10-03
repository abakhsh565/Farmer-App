# Dependency Registry — Farmer App

> **State as of 2026-10-04: every external connection has been removed at the owner's request.**
> The only live external service is the **weather API (Open-Meteo — keyless)**.
> No project reference, URL, key or token is recorded anywhere in this repository, by design.
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

- **Optional:** revoke the Supabase MCP integration (see §1, row 2). Nothing else is requested —
  no credential, no setup, no SQL.
