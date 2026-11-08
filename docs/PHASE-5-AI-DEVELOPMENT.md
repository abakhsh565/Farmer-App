# Phase 5 — AI Development

Status: **implemented and locally verified; staging schema and signed-out auth
verified; authenticated live acceptance blocked.**
The two migrations are recorded in staging, the later source gate is applied as
`20261108130627`, and `ai` v15 now enforces the repository's signed-out `401`.
No authenticated live lifecycle has been demonstrated. A Gemini key is reported
as configured in staging, but that is not an accepted live result.

## Staging evidence — 2026-11-08

- Staging ledger: **77** rows, including `20261105000100`,
  `20261105000200` and the forward-only source gate `20261108130627`.
- `ai_request_events`, `ai_rate_windows`, `ai_answer_feedback`,
  `agri_knowledge_ingestion_runs` and `agri_knowledge_ingestion_items` all
  exist with RLS enabled.
- `ai_knowledge_search` and `intelligence_recommendation_feed` both contain the
  source-permission and licence filter.
- `ai` **version 15** is deployed. A request with no auth header returns gateway
  `401`; a request with only the publishable key returns
  `401 {"error":"Sign in to use the assistant."}` before body parsing, so no
  model call is attempted.

## Staging evidence — 2026-11-06 (superseded)

- `GET /functions/v1/ai/health` returned 200 with
  `configured:true`, `active:"gemini"`, `model:"gemini-3.8-flash"` and
  `gateway:false`.
- `POST /functions/v1/ai/ask` with no auth and an empty body returned 400
  `A question is required.`; with the publishable key as bearer it also returned
  400; only a malformed bearer returned 401 at the gateway. The repository
  router would return 401 before parsing the body. The deployed function is
  therefore stale or misconfigured.
- An earlier anonymous question returned 200 with a grounded retrieval answer
  (`gate: agriculture`, confidence 60, citations). That is a live auth failure;
  whether it attempted a paid provider call is unknown. No further request was
  made without explicit cost authorisation.
- No signed-in staging JWT was available, so provider timeouts, retries,
  rate-limit responses, generated citations, Urdu/English output and telemetry
  remain unverified.

## Reused, not rebuilt

- Existing `ai` Edge Function routes and the client `AiProvider` contract.
- Existing `ai_knowledge_search` retrieval and `retrieveKnowledge` mapping.
- Existing `farmer_intelligence_context()` RPC and `buildFarmerPrompt()`.
- Existing recommendation, evidence-review and citation types.
- Existing knowledge lifecycle migration
  `20261105000100_knowledge_lifecycle_completion.sql`; this work does not
  duplicate acquisition, review or publication.

## Implemented

### Request lifecycle and identity

- Both `/ai/ask` and `/ai/diagnose` now require a verified JWT. Guests and
  invalid tokens get `401`; identity is never accepted from the body.
- Farmer context is read through the caller's own client, so `auth.uid()` and
  RLS apply. A client may select one of its active crops, but district and stage
  are taken from `farmer_intelligence_context`; arbitrary crop, stage or
  district fields are ignored.
- `requestId` is an optional bounded opaque id for duplicate protection and
  feedback. It is not a farmer id.

### Grounding and answer safety

- `supabase/functions/_shared/aiGuard.ts` bounds the model context, validates
  bracket citations against the retrieved set, rejects local weather claims,
  and rejects chemical/dose/active-ingredient statements unless a verified
  entry for the same crop and stage exists and contains the stated dose.
- Chemical advice also requires a pest/disease signal in the question. A model
  answer that fails the guard is replaced by a direct published retrieval
  excerpt and labelled as such.
- Diagnosis output is reduced to a short treatment-free problem label; product
  display is limited to a verified top entry at or above the confidence
  threshold. A malformed provider payload becomes an escalated `not_covered`
  result rather than an invented diagnosis.
- The prompt uses the Urdu body when the requested language is Urdu and keeps
  the same evidence and citation positions.

### Provider reliability

`supabase/functions/_shared/model.ts` now has:

- a total request budget and a per-attempt timeout with `AbortController`;
- up to three attempts by default, with exponential backoff and jitter;
- retry only for 429, 5xx, network/timeout, malformed and empty replies;
- explicit `rate_limited`, `malformed`, `refused`, `empty`, `unreachable` and
  `not_configured` outcomes, plus provider, model, HTTP status and attempt count;
- `Retry-After` support, bounded by the remaining total budget.

The Edge Function returns a direct published excerpt when generation fails,
when the model is not configured, or when the answer fails the safety guard. It
returns a generic error rather than a provider body or internal stack. Request
bodies are capped at 8 MB and image references at 6 MB.

### Rate limits, telemetry and feedback

Migration `20261105000200_ai_gateway_controls.sql` adds:

- `ai_request_events` — route, outcome, provider/model, latency, evidence and
  citation counts, and error code. It stores no question, prompt, image, crop,
  district, profile or citation text.
- `ai_rate_windows` — shared minute/day counters, 20/minute and 300/day per
  party, enforced in `ai_claim_request()` with the party derived from the JWT.
- `ai_answer_feedback` — a bounded helpful/not-helpful signal with an enum
  reason, not free text.
- `ai_claim_request()`, `ai_finish_request()` and `ai_feedback()`, granted only
  to `authenticated`; direct table access is revoked.

`POST /ai/feedback` accepts `{ requestId, helpful, reason? }`. The client
provider exposes `feedback()`; no farmer-facing UI was added.

## Verification

- `npm run typecheck`: pass.
- `npm run lint:functions`: pass — 18 sources, routes `ask`, `diagnose`,
  `feedback`.
- `npm run lint:migrations`: pass — 69 migrations, 90 tables (90/90 RLS), 189
  functions.
- `npm run db:bundle`: 69 migrations, `supabase/apply-all.sql`.
- `npm test`: 607 passed, 1 skipped, 65 files.
- `npm run lint`: pass.
- `npm run build`: pass — 2,161 modules.
- `git diff --check`: pass (CRLF advisory only).
- Focused AI tests: 29 passed — `aiGuard.test.ts` (12), `aiControls.test.ts`
  (6), `model.test.ts` (6), `recommendationConflict.test.ts` (5).
- `bash scripts/verify-ai-controls.sh` (`npm run verify:ai-controls`): **41/41
  cases pass** against a throwaway Supabase Postgres 17.6 carrying the full
  bundled schema. It proves the migration applies, the three control tables
  have RLS with all client grants revoked, only `authenticated` can execute the
  RPCs, a guest and a token without a party are refused, a replayed request id
  returns the same event without a second charge, the 21st claim in a minute is
  `rate_limited` for that party while another party is unaffected, a party
  cannot finish or give feedback on another party's request, telemetry clamps
  and persists route/outcome/provider/latency/counts, feedback upserts only
  after an answered request, and no question or prompt column exists.

These tests prove the local guards, the provider state machine and the database
controls on a real PostgreSQL. They do **not** prove the migrations are applied
to staging, that Gemini answers a live prompt, or that the Edge Function's HTTP
surface behaves under a real JWT. One anonymous staging request reached the
answer path; it was not a signed-in lifecycle test and no authenticated live
generation has been completed.

## Staging blockers and external dependencies

- ~~`20261105000100` and `20261105000200` are not applied to staging.~~
  **Resolved 2026-11-08:** both are recorded in the ledger, with the source gate
  applied as `20261108130627`. Tables, RLS and function grants were read back.
- A live Gemini request needs an approved signed-in staging account and explicit
  cost authorisation. The deployed function reports Gemini configured; neither
  an account nor a paid-call authorisation is available. Do not put a key in a
  request, source file, `.env.example`, or client bundle.
- ~~The deployed Edge Function must be replaced.~~ **Resolved 2026-11-08:**
  `ai` v15 returns `401` before body parsing for signed-out callers.
- Phase 3's acquisition/review/withdrawal schema is now present in staging, but
  the human approval, reviewer identity and licence decisions remain absent.
- No production deployment or production request was made.

## Status

**Blocked for live acceptance**, not complete. The throwaway-Postgres harness
proves the schema, grants, RLS, rate limits, duplicate protection, telemetry and
feedback persistence; the staging schema and the signed-out `401` are now
verified. What remains is authenticated: isolate one farmer's context from
another through the HTTP route; obtain a grounded answer with real citations;
exercise no-evidence / withdrawn / expired / unreviewed / unlicensed exclusions;
exercise provider 429, 5xx, timeout and malformed behavior; and apply the same
safety constraints in English and Urdu. No approved authenticated live call was
completed. Do not make more paid calls without explicit authorisation.
