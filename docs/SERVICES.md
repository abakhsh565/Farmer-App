# The service layer

`src/services/` is the boundary between the product and everything outside it.
Its purpose is a single requirement from the brief:

> the production provider must later be replaceable **without redesigning the
> feature or rewriting the product flow**

Screens and stores never import a vendor, never build a client, and never read
configuration. They ask for a capability.

```
screens / stores
      │  useServices()
      ▼
  ┌───────────────────────────────────────────┐
  │ contracts  ──  src/services/types.ts      │
  └───────────────────────────────────────────┘
      ▲                          ▲
      │                          │
development providers      remote providers
providers/develop.ts       providers/remote.ts
(complete, no keys)        (activate when configured)
      ▲                          ▲
      └──────────┬───────────────┘
                 │
          registry.ts chooses
       from config.ts (VITE_* vars)
```

## What lives where

| File | Responsibility |
| --- | --- |
| `types.ts` | Every contract, plus the honesty rules that belong beside them: `isWeatherUsable`, `isRateQuotable`, `rateRange`, `AI_CONFIDENCE_THRESHOLD` |
| `config.ts` | The only place that reads the environment, and the allowlist that decides what may be a client variable |
| `providers/develop.ts` | Complete behaviour on local data, including the failure paths |
| `providers/remote.ts` | The real backend, reading normalised services and our own endpoints |
| `registry.ts` | Chooses implementations, exposes them through React context |
| `otpFlow.ts` | The verification flow as a pure state machine |

## Security: what may be a `VITE_*` variable

Anything named `VITE_*` is inlined into the JavaScript bundle and therefore
**shipped inside the APK**, where anyone can read it with a zip tool.

So the only credential in `config.ts` is the Supabase **anon** key, which is
designed to be public: it grants nothing on its own, because every table is
behind row level security that checks `auth.uid()`.

Deliberately **absent**, and why:

| Key | Why it is not in the client |
| --- | --- |
| AI / LLM key | The client calls our AI Edge Function. A model key in the bundle is a key published on the internet |
| WeatherAPI key | Weather is ingested server-side into `weather_readings`; the client reads `latest_weather()`. This is also what makes the PRD rule "the UI and the AI use the same normalised weather service" true rather than aspirational |
| AMIS credentials | Same reason — ingestion is server-side into `market_observations` |
| SMS provider secret | The client calls our OTP Edge Function |
| Dealer system token | Dealers are a server-side projection |
| Supabase `service_role` key | Never in any client. Edge Functions only |

If a key you are about to add is not safe to publish on a billboard, it does not
go in `config.ts`.

## Choosing a provider

Selection is entirely configuration-driven, so one build runs both ways.

```
VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY   → persistence, weather, market, dealers
VITE_AI_ENDPOINT                              → AI
VITE_OTP_ENDPOINT                             → one-time codes
VITE_DEALER_ENDPOINT                          → dealer integration endpoint
VITE_POSTHOG_KEY                              → analytics
```

Two rules are encoded in `createServices` rather than left to a caller:

- **Persistence, weather, market and dealers switch together.** They are all
  reads of the same normalised backend; having one remote and another local would
  let the app contradict itself about the same fact.
- **AI and OTP switch independently.** They are separate endpoints that can be
  deployed at different times, and pretending otherwise would mean claiming a
  feature works before it does.

`configurationReport()` returns what is actually live, so the alignment ledger
and the diagnostics panel are generated rather than hand-written.

## Why the development providers are real

The brief is specific that a feature must not be left as "fake UI only". Each
development provider implements the full contract **including the paths that only
appear when things go wrong**, because those paths are the ones that would
otherwise first be discovered against a live vendor by a farmer:

- Weather returns `fresh`, and returns `failing`/`unavailable` for a location
  outside the fixture — so "advice pauses when the reading is unusable" is a
  tested code path, not a comment.
- Market carries a **stale** commodity (maize, 5 days old) and a commodity with a
  genuinely **unreported** minimum (rice). Those two rows make "never present a
  stale rate as current" and "never turn a missing value into zero" testable.
- AI runs the actual pipeline — domain gate, knowledge retrieval, confidence,
  citations, escalation — and is **deterministic**, so a test asserts an answer
  rather than tolerating any answer. A question the knowledge base does not cover
  returns `not_covered`, low confidence and an escalation.
- OTP has expiry, an attempt limit and a resend cooldown. Two of those are what a
  naive implementation gets wrong.
- Dealers do real haversine distance with the 100 km ceiling applied inside the
  provider, so the rule survives a caller that forgets it.

Fixtures live **in the development provider**, not in the domain layer. A
coordinate invented for testing is not a fact about a real shop, and putting it
beside the domain types is how test data ends up shipped as truth.

## The `developmentCode` field

`OtpRequest.developmentCode` is present on the development provider and
**absent** on the remote one. The type makes it optional, so a screen that renders
"here is your code" compiles against development and has nothing to render
against production. That is deliberate: an affordance that must not ship should
fail to be built rather than rely on someone remembering to remove it.

## The `Repository` boundary

```ts
read<T>(collection, ownerId): Promise<T | null>
write<T>(collection, ownerId, value): Promise<void>
remove(collection, ownerId): Promise<void>
```

Both implementations are async, **including the local one**. That is not
incidental: a synchronous local repository would let a screen depend on data
being immediately available, and that dependency would surface as a bug only on
the day the Supabase repository replaced it.

`SupabaseRepository` talks to `client_document_get` / `client_document_put` /
`client_document_delete` (migration 0015), which carry revision checking so two
devices cannot silently overwrite each other.

### What this boundary is not

`client_documents` stores each store's existing document shape. It is a **staging
step**, not the destination. The authoritative records — `credit_requests`,
`field_visits`, `community_posts`, `crop_instances`, `recommendations` — have
their own tables with constraints and guarded RPCs, and rules must live there,
never in a document. Migration 0015 says this in its own comment so a future
reader cannot mistake the staging table for the model.

## Current status

| Piece | State |
| --- | --- |
| Contracts | Built and tested |
| Development providers | Built, 44 tests |
| Remote providers | Written against the real backend, **never executed** — no database or endpoint yet |
| Registry + React wiring | Built, mounted in `App.tsx` |
| Repository interface | Built, both implementations written |
| **Stores moved onto the repository** | **DONE** — session, credit, visits, insights, community and dealer chat all read and write through `usePersistentDocument`; no store touches `localStorage` |
| Dealer listings for a scan result | **DONE** — `DealerProvider.stockists` (migration `0017`) rather than a fixture beside the treatment |
| Sync health, shown to the farmer | **DONE** — the profile's *Data & services* section, generated from the running configuration and the live write queue |

## Tests

`src/services/services.test.ts` — 44 tests covering:

- weather freshness and the unusable path
- market NULL preservation, staleness, and `rateRange` returning `null` rather
  than `0 – 0`
- the AI gate, the not-covered escalation, knowledge citation, and the weather caveat
- OTP completion, replay refusal, expiry, attempt lockout, and resend cooldown
- the OTP flow machine's transitions and per-reason error wording
- repository round-trip, per-owner isolation, and corrupt-document recovery
- dealer radius ceiling, temporary origin, freshness reporting, and NULL quantity
- stockists: nearest-first, confirmed-out excluded, unreported stock kept as
  unknown, the listing's own sync state and observation time, and the radius
- registry selection in both configured and unconfigured states

```bash
npx vitest run src/services
```
