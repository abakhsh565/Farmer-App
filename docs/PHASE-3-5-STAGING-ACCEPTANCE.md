# Phase 3/5 — contract matrix and staging acceptance

Status: **local contracts verified; staging acceptance blocked.**

This document is the bridge between the throwaway-Postgres evidence and the
hosted environment. It does not claim that the new migrations are deployed. It
names each required control, the local case that exercises it, and the exact
staging observation that would close it.

## Contract matrix

| Requirement | Local evidence | What staging must show |
| --- | --- | --- |
| Unauthorized publishing is refused | `scripts/verify-intel.sh`: a farmer publishes evidence / withdraws published evidence; a farmer records source terms | Call `agri_publish_evidence` and `agri_withdraw_evidence` with a farmer JWT: `42501`, no status change, no audit row written by the farmer |
| Invalid source licensing is refused | `scripts/verify-intel.sh`: a farmer records source terms; an admin grants a licence with no name; `agri_ingest_knowledge_document` permission gate | `agri_set_source_terms` with `granted` and null licence returns `23514`; a source left `unknown` cannot ingest; the source row is unchanged |
| Withdrawn evidence is excluded | `scripts/verify-intel.sh`: withdrawal returns the report to unverified; the withdrawn match leaves no pointer; an expired risk leaves the feed | Withdraw a published dossier; the linked knowledge/advisory/rule is unpublished or inactive; retrieval and `/intel/feed` no longer return it |
| Expired evidence is excluded | `scripts/verify-intel.sh`: matching to an expired advisory; an expired risk leaves the feed | Set `valid_until`/`expires_at` in the past; the next retrieval/feed call excludes the row |
| Unreviewed evidence cannot activate a rule | `scripts/verify-intel.sh`: an admin activates it without reviewed evidence (refused), then the fixture dossier is promoted | Activate a rule with no published dossier: `23514`/`42501`; after a real review + publish, activation succeeds and writes an audit row |
| Citation integrity | `scripts/verify-intel.sh`: a risk carries its citation; `src/intelligence/aiGuard.test.ts`: an unretrieved citation, missing citation, and supplementary chemical advice are rejected | `/ai/ask` returns citations whose ids/slugs resolve to the retrieved published rows; a fabricated bracket citation is replaced by the retrieval fallback |
| Cross-farmer isolation | `scripts/verify-isolation.sh` (15 cases); `scripts/verify-ai-controls.sh` (41 cases); `scripts/verify-recovery.sh` (20 cases) | Two accounts cannot read/write each other's documents, AI events, feedback, or control rows; RLS is enabled on all application tables |
| Trusted context cannot be bypassed | `src/intelligence/aiGuard.test.ts`: only an active crop is selected; stage and district come from the database; `src/intelligence/aiContext.test.ts`: no farmer id is accepted from the request | Send a body with forged `farmerId`, crop, stage, district: the response uses only the JWT-derived context; a guest gets `401` |
| Evidence controls cannot be bypassed by AI | `src/intelligence/aiGuard.test.ts`: citations and chemical doses require retrieved verified evidence; `scripts/verify-ai-controls.sh` | Ask a chemical question with no verified evidence: the response is a retrieval fallback or refusal, never a generated dose; apply the same check in English and Urdu |
| Rate limit and replay | `scripts/verify-ai-controls.sh`; `scripts/verify-performance.sh`: 20 concurrent claims | 21st claim in a minute is `rate_limited`; a replayed `requestId` returns the same event without charging twice |
| Recovery | `scripts/verify-recovery.sh`: 20/20, including schema, data, RLS, RPCs, auth provisioning, partial/killed restore | Restore a staging backup into a separate database; compare schema/data fingerprints and run the same RPC checks |
| Performance | `scripts/verify-performance.sh`: 21/21 | Repeat against the staging target only after explicit approval; record p50/p95/p99 and errors; do not use production |

## Local commands

Run from the repository root. Each command starts and removes a disposable
Supabase Postgres container; none reads a hosted credential.

```bash
npm run db:bundle
npm run verify:isolation
npm run verify:ai-controls
npm run verify:recovery
npm run verify:performance
bash scripts/verify-intel.sh
npm test
npm run typecheck
npm run lint
npm run lint:migrations
npm run lint:functions
npm run build
```

Expected today: isolation green, AI controls **41/41**, recovery **20/20**,
performance **21/21**, intelligence **76/76** after the licensing/publishing
cases, and the unit suite green (607 passed, 1 skipped at the Phase 8 baseline).

## Staging prerequisites

The following are external and must not be invented:

1. A SQL-write path to staging project `swmbmtvwgksicfnfsehg`: `psql` connection
   string or a Management API token with write access. The MCP path is
   permission-denied and there is no local `psql`.
2. Explicit operator approval to apply the two forward-only migrations
   `20261105000100_knowledge_lifecycle_completion.sql` and
   `20261105000200_ai_gateway_controls.sql`. Do not use `supabase db push` from
   this work, and do not insert ledger rows by hand.
3. A named reviewer holding `evidence_reviewer` and/or `content_manager`
   authority, plus an agronomist sign-off for any agronomic threshold.
4. A source record whose publisher permission and licence are actually recorded.
   `unknown` and `needs_permission` must stay blocked.
5. An approved `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) in the Edge Function secret
   store for a live-provider test. No key is present in this environment.
6. Explicit authorization before any production operation. None is granted.

## Staging procedure

### 1. Preserve the current state

```bash
export STAGING_DATABASE_URL='postgresql://...'   # operator-provided; never commit
pg_dump "$STAGING_DATABASE_URL" --format=custom --file="staging-before-phase8.dump"
pg_dump "$STAGING_DATABASE_URL" --schema-only --file="staging-before-phase8-schema.sql"
```

Record the migration ledger and row counts before applying anything:

```bash
psql "$STAGING_DATABASE_URL" -X -A -F '|' -c \
  "select version, name from supabase_migrations.schema_migrations order by version;"
psql "$STAGING_DATABASE_URL" -X -A -F '|' -c \
  "select 'crop_reports', count(*) from public.crop_reports
   union all select 'ai_request_events', count(*) from public.ai_request_events;"
```

### 2. Apply the two migrations through the approved runner

Use the organization's approved migration path. If it is the Supabase CLI, the
operator command is:

```bash
supabase db push --db-url "$STAGING_DATABASE_URL"
```

This command is documented for the operator only; it was **not** run by this
work. The required outcome is two ledger rows and no rewrite of any earlier
migration.

### 3. Persisted-state checks

```bash
psql "$STAGING_DATABASE_URL" -X -A -F '|' -c \
  "select version from supabase_migrations.schema_migrations
    where version in ('20261105000100','20261105000200') order by version;"
# expected: 20261105000100, 20261105000200

psql "$STAGING_DATABASE_URL" -X -A -F '|' -c \
  "select tablename, rowsecurity from pg_tables
    where schemaname='public'
      and tablename in ('ai_request_events','ai_rate_windows','ai_answer_feedback','agri_evidence_items','agri_knowledge_sources');"
# expected: five rows, rowsecurity = t

psql "$STAGING_DATABASE_URL" -X -A -F '|' -c \
  "select proname, has_function_privilege('authenticated', oid, 'execute') as auth,
          has_function_privilege('anon', oid, 'execute') as anon
     from pg_proc
    where proname in ('ai_claim_request','ai_finish_request','ai_feedback',
                      'agri_publish_evidence','agri_withdraw_evidence','agri_set_source_terms');"
# expected: authenticated true; anon false
```

Check that no fabricated review or permission was seeded:

```bash
psql "$STAGING_DATABASE_URL" -X -A -F '|' -c \
  "select count(*) from public.agri_knowledge_sources
    where permission_status in ('granted','not_required')
      and license_name is null;"                     # expected 0
psql "$STAGING_DATABASE_URL" -X -A -F '|' -c \
  "select count(*) from public.agri_evidence_items
    where status='published' and reviewer_id is null;"  # expected 0
```

### 4. HTTP acceptance

Use a real signed-in farmer JWT and a second farmer JWT. Do not paste tokens into
the repository.

```bash
# guest: 401
curl -sS -o /dev/null -w '%{http_code}\n' \
  -X POST "$STAGING_URL/functions/v1/ai/ask" -H 'content-type: application/json' \
  -d '{"question":"How do I control pink bollworm?"}'

# farmer A: grounded answer, citations resolve
curl -sS -X POST "$STAGING_URL/functions/v1/ai/ask" \
  -H "authorization: Bearer $FARMER_A_JWT" -H 'content-type: application/json' \
  -d '{"question":"How do I control pink bollworm?","requestId":"staging-a-1"}'

# forged context must not change the district/crop actually used
curl -sS -X POST "$STAGING_URL/functions/v1/ai/ask" \
  -H "authorization: Bearer $FARMER_A_JWT" -H 'content-type: application/json' \
  -d '{"question":"What should I spray?","farmerId":"other","district":"lahore","cropCode":"wheat"}'
```

Persist the evidence: the `ai_request_events` row for `staging-a-1` must have
`party_id` = farmer A's party, an outcome of `started` or `answered`, and no
question text; farmer B must not be able to read or finish it. A replayed
`staging-a-1` must return the same event id and not increment the rate counter.

### 5. Record the result, then stop

Write the observed ledger rows, table/RLS checks, HTTP status, response
`requestId`, citation slugs and persisted event counts into the Phase 8 report.
If any prerequisite is missing, record the blocker; do not substitute a local
result for staging evidence.

## Current blockers

- No staging SQL-write credential or local `psql`.
- No approved reviewer/content-manager identity or agronomist sign-off.
- No permitted source record.
- No approved Gemini key.
- No production authorization.
