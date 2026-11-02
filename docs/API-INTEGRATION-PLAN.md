# API integration plan — every external service

Status as of 4 October 2026. Every row states what is *proven*, what is
*unverified*, and who owns the next step. Nothing here is marked done on the
strength of an assumption.

Rule that applies to every row: **no key is ever pasted into chat.** The owner
pastes into a dashboard; the agent reads configuration back through tooling and
reports booleans only.

---

## Summary

| # | Service | State | Cost | Owner step |
|---|---|---|---|---|
| 1 | Supabase (DB + Auth + Storage) | ✅ proven | free tier | none |
| 2 | GitHub | ✅ proven | free | none |
| 3 | Vercel | ✅ proven | free | revoke pasted token |
| 4 | Weather — Open-Meteo | ✅ proven live | **free, keyless** | none |
| 5 | AI — Gemini | ⚠️ **unverified** | free tier | deploy gate only |
| 6 | SMS / OTP | ✅ proven (test mode) | paid when live | pick provider |
| 7 | Push — FCM | ❌ not started | **free** | create Firebase project |
| 8 | Analytics — PostHog | ⚠️ code done, keyless | **free, 1M events/mo** | paste project key |
| 9 | Maps | ❌ not started | **free if keyless** | none (recommend keyless) |
| 10 | AMIS market feed | ❌ not started | unknown | source decision |
| 11 | Dealer / POS sync | ❌ not started | — | later phase |

---

## 1–3. Supabase, GitHub, Vercel — done

Supabase project `swmbmtvwgksicfnfsehg` is live with 17 of 19 migrations applied
and row level security enforced. Phone OTP sign-in was **proven end to end** on
4 October 2026: an OTP request returned HTTP 200 and the test code produced a
session with a confirmed `phone` identity.

GitHub repository is connected and CI is green. Vercel auto-deploys from `main`
and the production site is serving real weather data.

**Outstanding:** the Vercel API token pasted into chat must be revoked in
Vercel → Account Settings → Tokens. Nothing depends on it.

## 4. Weather — done, permanently free

Open-Meteo requires no key and no account. The deployed app reads it directly
(`VITE_WEATHER_PROVIDER=open-meteo`) and the live site has been observed showing
a real reading. This is the one dependency in the project that can never
generate a bill.

## 5. AI — Gemini, unverified

The owner set `GEMINI_API_KEY` in Supabase → Edge Functions → Secrets. **This
has not been confirmed.** There is no tool that can read secrets, and the
`ai` function is not deployed, so the health endpoint that would report
"configured: true" does not exist yet.

The single blocker is the Supabase CLI login, which is a browser approval. Once
the four edge functions deploy, `GET /functions/v1/ai/health` reports booleans
only — which providers are configured and which is active — and no key is ever
printed.

The client already supports any OpenAI-compatible gateway via `OPENAI_BASE_URL`,
so a future provider swap is configuration, not code.

## 6. SMS / OTP — proven in test mode, real delivery deferred

Phone sign-in works today through Supabase Auth's test OTP mapping
(`+923001234567` → `123456`). That path costs nothing and exercises the entire
sign-in flow including identity confirmation.

**Real SMS costs money and cannot be free.** Researched 4 October 2026:

- Every credible provider bills per message segment. Twilio's headline
  $0.0083 is the **US local** rate; Pakistan is an international destination and
  costs materially more. The exact per-message figure is rendered client-side on
  Twilio's country page and must be read from their pricing calculator — it is
  deliberately not guessed at here.
- Providers that support Pakistani delivery: Twilio, Telnyx, MessageBird, Vonage,
  and locally Jazz / Telenor / Zong through an aggregator.
- Every provider offers free trial credits, which is enough to build and prove
  the integration at no cost before any volume is sent.
- Supabase's own SMS rate limits are the real constraint to plan around: one OTP
  request per 60 seconds, a 60-second code lifetime, and a project-wide hourly
  send cap. For a shared phone in a village these must be raised, or farmers will
  be locked out.

**Owner decision, whenever they want it:** create the provider account, then
paste credentials into Supabase → Authentication → Providers → SMS. No code
change is required — the config path is already built.

## 7. Push notifications — free, not started

Firebase Cloud Messaging is **free on Google's Spark plan with no
per-message charge and no monthly message-count limit** (verified 4 October
2026). The only limit is platform throttling of 600,000 messages per minute,
which a smallholder app will not approach. This is the cheapest meaningful
capability in the plan.

What does not exist yet:

- No Firebase project.
- No Capacitor push plugin in the app.
- No device-token table in the database, so nothing would record which handset
  belongs to which farmer.

**Owner step:** create a free Firebase project (Google account, no card
required), register the Android app, and paste the config values into Vercel
environment variables — never into chat.

**Agent step:** add the push device-token table and RLS policy, register tokens
on app open, and add the notification fan-out that respects existing
`notification_events` rows.

## 8. Analytics — free, code already written

PostHog's free tier is **1,000,000 events per month**, plus 5,000 session
recordings and 100,000 error-tracking events, resetting monthly (verified
4 October 2026). Roughly 30 events per farmer per day would exhaust it, so it is
effectively unlimited for this app's early scale.

`src/services/config.ts` already reads `VITE_ANALYTICS_KEY` (with `VITE_POSTHOG_KEY` accepted as a fallback) and `VITE_POSTHOG_HOST`
and exposes a `configured` flag — the integration is written and simply has no
key. **This is the cheapest win available: one key turns a dormant feature on.**

**Owner step:** create a free PostHog project and paste the project key into
Vercel as `VITE_ANALYTICS_KEY` for Production.

## 9. Maps — keyless is genuinely possible

The app needs no map key today. If maps are wanted later, the keyless route is
MapLibre GL with OpenStreetMap tiles, which costs nothing and needs no account.
Google Maps and Mapbox both require keys and bill at volume, and Mapbox raised
its pricing substantially.

**Recommendation:** build keyless, keep a provider abstraction, and revisit only
if tile hosting becomes a real cost.

## 10. AMIS market feed — blocked on a source decision

The ingestion adapter is already written and reads `AMIS_FEED_URL` /
`AMIS_FEED_TOKEN`. AMIS publishes Punjab market data as documents and reports
rather than a documented public API with keys, so the realistic options are a
scraped or manually supplied feed, or a paid aggregator. The database already
carries a `research_feed` source explicitly marked as non-authoritative, so
development can proceed without pretending the data is live.

## 11. Dealer / POS sync — later phase

The read projection (`dealer_products`, `dealer_sync_runs`) and staleness
reporting are built. What is missing is a sync worker against the POS system,
which belongs to a separate account and is deliberately untouched.

---

## The one unblock that matters most

**Supabase CLI login.** One browser approval deploys all four edge functions,
and deploying them is the only way to convert item 5 from "unverified" to
"proven". Every other item above is either already done, free, or waiting on the
owner's own account creation.