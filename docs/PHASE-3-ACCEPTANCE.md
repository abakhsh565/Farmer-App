# Phase 3 — Acceptance and Regression Baseline

Status: **ACCEPTED** for Phase 3 on 2026-11-03. This is not a claim that the full
App suite is green. The 33 App-suite failures below are accepted as the existing
UI-redesign baseline; Phase 3 did not modify the production areas they exercise.

Lifecycle completion addendum (2026-11-05, updated 2026-11-08): the later
acquisition, withdrawal, licence and stage-aware retrieval work is **not**
covered by this acceptance. Its migration is now applied to staging (with the
forward-only source gate `20261108130627`), but there is no signed-in lifecycle
evidence and no human approval. The bundled
schema including it now applies cleanly to throwaway Supabase Postgres and
`scripts/verify-intel.sh` passes 78/78 cases there, including evidence-gated
activation and risk generation; that is local runtime evidence, not staging
acceptance. See [`docs/PHASE-3-KNOWLEDGE-ENGINE.md`](PHASE-3-KNOWLEDGE-ENGINE.md)
§8. This document continues to describe only the 2026-11-03 retrieval acceptance.

## Evidence

- `docs/INTELLIGENCE-FOUNDATION.md` recorded `371 passed, 33 failed, 1 skipped`
  before Phase 1 and explicitly attributed the 33 failures to the pre-existing
  UI-redesign backlog.
- Current full App run: `64 passed, 33 failed` across 9 files.
- The failure set is in chat, credit, identity, isolation, visits, location,
  location-search, resilience, and three profile/Shop tests in `App.test.tsx`.
- Phase 3 production changes are limited to the knowledge schema/retrieval,
  `/ai/ask`, Scan source rendering, i18n Scan keys and shared AI contracts.
  No Scan/assistant test is in the failure set; the focused Scan suite is 7/7.
- The three failures in `App.test.tsx` are Home/Shop/Profile navigation tests, not
  Scan. `src/App.tsx`, `HomeScreen.tsx`, `ProfileScreen.tsx` and `AppTabBar.tsx`
  were already modified in the existing worktree before Phase 3; Phase 3 did not
  change them.
- No unrelated historical failure was fixed, hidden, skipped, or reclassified as
  passing.

## Accepted baseline — all 33 tests

- `src/App.chat.test.tsx > chat > keeps what was sent after the app is reopened, and carries the history into the account`
- `src/App.credit.test.tsx > answering a counteroffer > shows what the shop owner changed, and needs an account to accept`
- `src/App.credit.test.tsx > sending a request > refuses to send without consent, and sends with it`
- `src/App.credit.test.tsx > sending a request > refuses a second live request for the same order`
- `src/App.identity.test.tsx > the identity gate > asks once, for the right reason, and publishes the post after sign-in`
- `src/App.identity.test.tsx > the identity gate > creates the account by email too, with the same code step`
- `src/App.identity.test.tsx > the identity gate > refuses an incomplete number without creating an account`
- `src/App.identity.test.tsx > the identity gate > says a wrong code is wrong, and lets the farmer try again`
- `src/App.identity.test.tsx > the identity gate > tells the farmer a code expired instead of calling it wrong`
- `src/App.identity.test.tsx > the identity gate > returns to the number when the code could not be sent at all`
- `src/App.identity.test.tsx > the identity gate > lets the farmer keep browsing, with the draft still in the box`
- `src/App.identity.test.tsx > the identity gate > sends a dealer message only after the sign-in it asked for`
- `src/App.isolation.test.tsx > two farmers on one phone > shows the next person none of the previous farmer’s name, chat or credit`
- `src/App.isolation.test.tsx > two farmers on one phone > shows a farm summary only from stored data, never a fixture`
- `src/App.isolation.test.tsx > two farmers on one phone > gives each farmer their own crop summary after signing in`
- `src/App.journeys.test.tsx > the field-visit journey > asks for an account, sends the request, records the dealer’s answer, and survives a restart`
- `src/App.journeys.test.tsx > the field-visit journey > lets a farmer ask again after a refusal, which the copy promises`
- `src/App.journeys.test.tsx > signing out and back in > leaves the account’s work behind on sign-out, and returns it on sign-in`
- `src/App.location.test.tsx > a guest and their location > says plainly that nothing is saved yet, and searches the default area anyway`
- `src/App.location.test.tsx > a guest and their location > keeps a chosen area temporary, says so, and offers to save it`
- `src/App.location.test.tsx > a guest and their location > keeps a chosen area for a guest, with no account asked for`
- `src/App.location.test.tsx > a guest and their location > names the place a temporary search will not replace`
- `src/App.location.test.tsx > the search range > is not undone by a saved location on the same phone`
- `src/App.locationSearch.test.tsx > finding your area by name > lives in the filter, and opens a page to type a place into`
- `src/App.locationSearch.test.tsx > finding your area by name > asks the geocoder with the farmer’s own words and lists what comes back`
- `src/App.locationSearch.test.tsx > finding your area by name > says nothing was found rather than showing an empty list`
- `src/App.locationSearch.test.tsx > finding your area by name > keeps the tapped place for a guest, with nothing to sign up for`
- `src/App.locationSearch.test.tsx > finding your area by name > says the area is on this phone rather than in an account`
- `src/App.locationSearch.test.tsx > finding your area by name > writes to the account instead when there is one, and leaves nothing on the phone`
- `src/App.resilience.test.tsx > a session with no party id yet > keeps the work on the phone and never queues a write that cannot succeed`
- `src/App.test.tsx > App > sends the home dealer section to the Shop screen`
- `src/App.test.tsx > profile > opens from the header and returns with back`
- `src/App.test.tsx > profile > sends My Dealers to the Shop tab`

## Not accepted as green

This baseline is recorded so Phase 3 regression work is distinguishable from the
historical UI redesign backlog. It does not make the App suite a passing gate and
does not authorize unrelated screen redesigns.

## Phase 3 acceptance checks

- English and Urdu natural-language retrieval return the verified Punjab entry
  first; unrelated cricket query returns no rows.
- Selected-crop ranking and verified-before-supplementary ordering are verified
  against staging SQL.
- Retrieval-only `/ai/ask` response is live-verified at HTTP 200 with explicit
  `generation: "retrieval"` and citations.
- Source presentation is covered by the focused Scan test for verified and
  supplementary sources, including safe HTTPS link rendering.
- Security: source table RLS; no client source access; no client write grants on
  knowledge/index/source; retrieval execute is service-role only; farmer context
  remains JWT-derived and unchanged.

## External documentation blocker

The Notion PRD write remains blocked because `notion-update-page` and
`notion-create-pages` are not in the approved Notion tool set. The full record is
in `docs/PHASE-3-KNOWLEDGE-ENGINE.md`; the Notion page itself was not changed.
