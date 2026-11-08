# Phase 5.2 — Agricultural Evidence & Review Management

Status: **implemented, applied to staging on 2026-11-04, and exercised against a
transaction-scoped fixture suite**. The real approval and activation paths remain
closed: there is no named evidence reviewer or content manager in staging, no
permission for an official advisory feed, and no agronomist sign-off for any
threshold. Phase 6 has not been started.

This is an extension of the existing knowledge, advisory, forecast-risk,
recommendation and alert objects. It is **not** a second advice engine, a second
notification table or a generic event-log product.

---

## 1. Existing architecture audit

The audit read the actual staging schema and client code, not only the migration
files.

| Existing object | Finding | Reused as |
| --- | --- | --- |
| `agri_knowledge_sources` | Source registry with type, publisher, URL, status; no general per-evidence review dossier. | The evidence record carries `source_code` when it cites a registry source. |
| `agri_knowledge_entries` | Bilingual, versioned entries with `is_published`, `evidence_tier`, source fields and reviewer fields. Eight rows existed; all eight published, one verified. | Publication target for a knowledge evidence dossier. Existing `version`, `is_published`, `evidence_tier` and source fields remain canonical. |
| `agri_knowledge_index` | Retrieval-only index. | Untouched. |
| `agri_advisories` | Phase 5.1 verification fields existed, but **zero rows** and no source-permission feed. | Verification target; direct verification without published evidence is now blocked. |
| `forecast_risk_rules` | One inactive `spray-wind-too-strong` rule, threshold 30 kph, supplementary citation, no version or deactivation columns. | Added evidence link, `version`, deactivation fields. The existing rule remains inactive and is not evidence of a validated threshold. |
| `forecast_risks` | No active rule and no live rows. | Untouched; remains a modelled risk, never an observed event or outbreak. |
| `recommendations` | Canonical recommendation/alert row; already had `reason_context`, `rule_version`, `knowledge_version`, source metadata and alert fields. | Added `evidence_item_id` and `decision_trace`; one before-write trigger, no second decision table. |
| `notification_events` | Pointer-only inbox. | Untouched. |
| `audit_log` / `write_audit` | Existing append-only audit path. | Reused by every evidence transition. |
| `party_capabilities` | Empty; allowed capabilities are `moderator`, `admin`, `expert`. | Deliberately **not** used as review authority. Admin is not an agronomist. |
| Reviewer UI | None existed. | Added a gated Profile entry and pushed `ReviewScreen`. |

Existing components reused: `Sheet`, `Dialog`, `Input`, `Textarea`, `Field`,
`Badge`, `Button`, `EmptyState`, `LoadingState`, `ErrorState`, typography/tokens
and the LocaleProvider. Direction is logical throughout; no screen-local RTL
branch was added. English and Urdu keys are both complete.

---

## 2. New schema

Migrations:

- `20261103001100_evidence_review.sql` — tables, links, authorities, guards.
- `20261103001200_evidence_review_operations.sql` — review/publication/read RPCs.
- `20261103001300_decision_trace.sql` — recommendation trace, grants, backfill.

All three were applied through the established Management API query path and
returned HTTP 201. The staging migration ledger still reports **23** rows. The
Management API does not write `schema_migrations`; **no ledger row was invented**
and `supabase db push` was not used. `supabase/apply-all.sql` was regenerated
from **45 migrations**.

### 2.1 `agri_review_authorities`

Named authority rows:

- `authority` is `evidence_reviewer` or `content_manager`;
- optional crop and district scopes (empty means all);
- grantor, grant time, revocation time and mandatory note.

`grant_agri_review_authority()` and `revoke_agri_review_authority()` are
admin-only. An administrator can grant access, but **does not receive reviewer
authority by being an administrator**. There is no UI for granting authority:
the human decision about who is qualified remains an owner decision.

### 2.2 `agri_evidence_items`

One versioned dossier per target (`knowledge_entry`, `official_advisory`,
`forecast_rule`). It records:

- source organisation, source type, registry code, HTTPS URL/document reference;
- document title, publication date, access timestamp, language;
- crop, topic, districts, stages;
- classification and optional confidence;
- status, source/applicability/agronomic checks;
- creator/submitter/reviewer/timestamps/notes/rejection/correction reason;
- validity window, publication/expiry timestamps;
- version, supersedes/superseded links and a unique evidence key.

Duplicate prevention is both structural (`unique(target_kind,target_ref,version)`
and `evidence_key`) and workflow-level (one open dossier per target). A second
dossier is allowed only after a closed or published version, and auto-links the
published predecessor as `supersedes_id`.

### 2.3 `agri_evidence_reviews`

Append-only ledger of `create`, `submit`, `start_review`, `source_check`,
`applicability_check`, `approve`, `reject`, `request_correction`, `resubmit`,
`publish`, `expire` and `supersede`. It stores the actor, actor role, from/to
status, note and bounded detail. A trigger rejects update/delete except a direct
PostgreSQL administration session, so a normal client or service role cannot
rewrite history.

### 2.4 Links

- `agri_knowledge_entries.evidence_item_id`
- `agri_advisories.evidence_item_id`
- `forecast_risk_rules.evidence_item_id`, `version`, deactivation fields
- `recommendations.evidence_item_id`, `decision_trace`

No second content row is created. Existing wording, versions and visibility
fields remain the served objects.

---

## 3. Classification and the three separate checks

Evidence classification values:

1. `official_government`
2. `peer_reviewed_research`
3. `qualified_expert`
4. `supplementary_editorial`
5. `unverified_submission`

The UI warns that a reputable organisation is not evidence by itself. Source
authenticity, applicability and agronomic approval are separate fields and
separate review actions:

- `source_check_status`: `pending` / `authentic` / `not_authentic`;
- `applicability_status`: `pending` / `applicable` / `not_applicable`;
- `agronomic_status`: `pending` / `approved` / `rejected`.

Approval requires `authentic` + `applicable`, a future validity end, an
inspectable URL/document reference and a non-unverified classification. A
deliberately untrusted fixture failed approval in staging. A source check alone
does not approve anything.

---

## 4. Lifecycle and authorization

```
Draft ──submit──▶ Submitted ──start──▶ Under review
                                            │
                     source + applicability checks
                                            │
                              approve ◀─────┴─────▶ reject
                                 │                    │
                              Approved              Rejected
                                 │
                              publish
                                 │
                              Published ──expire──▶ Expired
                                 │
                            new version
                                 └──────────────▶ Superseded
```

| Act | Authority | Server rule |
| --- | --- | --- |
| Create/submit/resubmit | `content_manager` | Scope must cover the target crop/district; creator is the JWT party. |
| Start review | `evidence_reviewer` | Scoped; a reviewer cannot review evidence they created or submitted. |
| Source/applicability check | `evidence_reviewer` | Only the reviewer who started the review; check-specific notes required. |
| Approve/reject/request correction | `evidence_reviewer` | All checks and validity rules enforced; rejection requires a reason. |
| Publish | `content_manager` | Only approved, unexpired evidence; distinct from agronomic approval. |
| Expire | `content_manager` | Deactivates the target and records a reason. |
| Supersede | `content_manager` | Same target, newer published version, target points at replacement. |

Every function derives the actor from `current_party_id()` (the JWT). No RPC
accepts a reviewer identity. Regional scopes are exact: an empty evidence crop
or district set means “all”, so it requires an all-scope authority; omission
cannot widen a scoped reviewer’s access.

### 4.1 Publication guards

Database triggers make the rule true even if someone calls an older RPC:

- publishing/keeping a knowledge entry published requires a **published**
  evidence dossier for that entry;
- `agri_advisories.verification_status = 'verified'` requires a published
  dossier for that advisory;
- a forecast rule becoming active requires a published dossier for that rule.

The original Phase 5.1 `verify_official_advisory()` and
`activate_forecast_risk_rule()` remain in place with their source, Urdu and
future-window checks. Their UPDATE now fails without a published dossier; they
were not weakened. The normal path is `agri_publish_evidence()`, which sets the
content fields and the evidence link in one transaction.

The existing eight published knowledge rows are legacy rows with no dossier.
They remain readable, but any new publication/change now requires evidence. No
dossier, reviewer or approval was fabricated for them.

---

## 5. Forecast-rule review

`forecast_risk_rules` gained `version`, deactivation metadata and an evidence
link. `agri_publish_evidence()` requires:

- approved, published, authoritative evidence for the rule;
- the cited knowledge entry to be published with `evidence_tier = verified`;
- that cited entry to have its own published authoritative evidence dossier;
- an active `forecast_risk` source;
- no conflicting active rule evidence; a new version must deactivate the old
  rule first.

A technically valid numeric threshold is therefore not automatically active.
`spray-wind-too-strong` remains **inactive**. The test rule used threshold `999`
solely to exercise the workflow and was labelled `PHASE 5.2 TEST FIXTURE`; it was
rolled back. No real threshold was invented. Forecast risks remain modelled
risks, not observed events or confirmed outbreaks.

---

## 6. Decision traceability

`recommendations` remains the single canonical decision. A before-insert/update
trigger attaches a bounded `decision_trace` containing the source, source kind,
rule/knowledge/scoring versions, evidence snapshot (version, status,
classification, reviewer timestamp, validity), crop/stage/district, alert level
and eligibility context. It does not include coordinates, phone numbers, other
farmers or free text.

`recommendation_decision_trace(p_recommendation_id)` returns:

- `farmer_explanation` for the owning farmer: wording, reason, source label,
  evidence status/classification, whether it is verified guidance, validity;
- `internal` only for a caller with review/admin authority: full trace, evidence
  record, versions, check outcomes, review history and count of decisions using
  the same evidence.

The farmer projection never contains reviewer IDs or internal notes. In staging,
a farmer without review authority received only `farmer_explanation`; a reviewer
received the internal block. Existing recommendation rows were backfilled only
where `decision_trace` was empty; historical wording and alert state were not
rewritten.

---

## 7. Reviewer UI

`Profile → Evidence & review` is shown only when the server returns
`can_review` or `can_manage`. The route is also gated by the same server context;
hiding the row is not the authorization boundary.

`ReviewScreen` provides:

- overview counts and status filters (`Pending`, `In review`, `Approved`,
  `Published`, `Closed`, `Rejected`);
- search over title/source/target;
- pending queue and closed/expired/superseded views;
- evidence detail with source document link, classification, applicability,
  independent checks, validity, target state and review history;
- source/applicability checks, approval, rejection, correction request, publish,
  expiry and correction/resubmit;
- internal decision trace for a linked recommendation;
- loading, empty, error, offline, confirmation and action-failure states;
- English/Urdu and logical RTL layout.

The add form collects source, document, dates, classification, crop-derived
scope, districts, stages, confidence and validity. It saves a draft or submits
for review. The UI cannot choose a reviewer identity.

---

## 8. Staging verification

The fixture script is transaction-scoped and was rolled back; no fixture remains
in staging. Every fixture was explicitly prefixed `PHASE 5.2 TEST FIXTURE` and
the test asserted `NOT REAL` text is not presented as real guidance. **No real
reviewer, advisory or threshold was created.**

The suite passed **30/30 checks**:

| Check | Result |
| --- | --- |
| Content manager cannot start/approve evidence | passed (SQLSTATE 42501) |
| Content manager context: can_manage true, can_review false | passed |
| Reviewer context: can_review true, can_manage false | passed |
| Create advisory evidence; derive wheat/Muzaffargarh scope | passed |
| Duplicate open dossier rejected | passed |
| Reviewer starts review; source authentic; applicable; approves | passed |
| Reviewer cannot publish | passed |
| Content manager publishes advisory; target becomes verified | passed |
| Review ledger recorded all acts | passed |
| Draft cannot be published | passed |
| Untrusted source cannot be approved | passed |
| Correction requested, content manager corrected/resubmitted | passed |
| Corrected evidence rejected with reason | passed |
| Knowledge evidence controls publication and verified tier | passed |
| New version auto-links supersedes and publishing supersedes old | passed |
| Supplementary threshold evidence rejected | passed |
| Forecast activation requires content manager | passed |
| Authoritative forecast evidence activates rule | passed |
| Advisory matches verified wheat/Muzaffargarh farmer | passed (0 → 1) |
| Wrong-crop advisory suppressed | passed (1 → 1) |
| Wrong-region advisory suppressed | passed (1 → 1) |
| Farmer trace has no internal block without review authority | passed |
| Reviewer receives internal trace | passed |
| Expiry deactivates advisory and rule | passed |
| Existing alert feed/weather regression | passed |
| Direct evidence/review/authority table access denied to authenticated | passed |

A separate live check used the existing staging recommendations: a normal
farmer with no review authority was refused another farmer's decision trace
with `This decision belongs to another farmer.` The check was read-only.

Additional static checks: typecheck, design lint, migration lint (45 files,
78 tables with RLS, 138 functions), production build. The focused intelligence
suite passed 100/100 tests. The full non-App suite passed **420 tests with 1
skipped** (46 files), including source/Urdu parity and fallback resolution. The
App suite was not rerun because it carries the documented 64/33 accepted
baseline; the changed code typechecks and builds.

The test harness simulated the authenticated party with
`request.jwt.claims.sub`, inserted temporary authority rows directly as the
PostgreSQL administrator, and rolled the entire transaction back. This exercises
the real security-definer functions and guards; it is not a claim that a real
person was appointed.

---

## 9. Unresolved human dependencies

1. **Name the evidence reviewers and content managers.** `agri_review_authorities`
   is empty in staging. An administrator must make and record that decision
   through `grant_agri_review_authority()`; there is intentionally no seeded
   “demo agronomist”.
2. **Permission for a real advisory source.** `punjab_advisory` remains
   `needs_permission`. No official advisory may be verified from an unpermitted
   source.
3. **Agronomist sign-off for any forecast threshold.** There is no validated
   threshold, so no rule may be activated. The existing spray-wind rule remains
   inactive.
4. **Production deployment.** The repository migration ledger is still
   incomplete. Applying these migrations to production requires the same
   explicit reconciliation decision described in Phase 5.1; do not run
   `supabase db push`.
5. **Push delivery** remains unconfigured. In-app alerts still work.

Until 1–3 are resolved, real approval and activation are **disabled by
authority and evidence**, not merely hidden in the UI.

---

## 10. Remaining limitations

- No automatic expiry scheduler: expiry is an explicit content-manager action.
  Advisory reads also enforce `valid_until`; knowledge and rule activation do not
  have a background clock.
- The existing eight published knowledge entries are legacy rows without
  evidence. They remain readable but must go through a dossier before any
  change.
- Review counts in `agri_review_context()` are global, not scoped; the queue
  itself is scoped. This is aggregate evidence metadata, not farmer data.
- There is no UI for granting/revoking authority. That is an administrative
  decision tool, not a reviewer action.
- The reviewer workspace was not exercised against a real appointed reviewer;
  the RPC path was exercised with temporary fixture grants.
- There is no push sender, no production deployment and no Phase 6 work.

---

## 11. Handover

Apply in order:

```text
supabase/migrations/20261103001100_evidence_review.sql
supabase/migrations/20261103001200_evidence_review_operations.sql
supabase/migrations/20261103001300_decision_trace.sql
```

`supabase/apply-all.sql` already contains all three. Apply through the existing
Management API/manual reconciliation path, never `db push` against the
incomplete staging ledger.

Then, as a human decision:

1. grant named authorities with `grant_agri_review_authority(party, authority,
   crops, districts, note)`;
2. obtain and permit a real source;
3. submit evidence, run the separate checks and approve;
4. publish only after approval;
5. obtain agronomist sign-off and evidence before activating a rule.

The safe default with no authority is the current state: no reviewer entry, no
real approval, no active forecast rule.

## Phase 5.2.1 — operational hardening

### Implemented
- **Authority administration.** `agri_review_authorities_list()` and `agri_review_authority_candidates(text)` are admin-only reads; the reviewer screen exposes a "Review authorities" dialog whenever the server reports `can_grant`. Grant and revoke reuse `grant_agri_review_authority` / `revoke_agri_review_authority`. Self-grant is refused server-side, `revoked_by` is recorded, and revocation blocks the next protected RPC immediately.
- **Scoped counts.** `agri_review_context()` now counts only dossiers the caller's authority actually covers. The queue already applied the same crop/district scope.
- **Scheduled expiry.** `agri_expire_due_evidence(timestamptz)` expires approved/published dossiers at `valid_until <= now()`, withdraws the linked knowledge entry, advisory or forecast rule, writes an `expire` row to the append-only ledger as actor role `system`, and is idempotent. A pg_cron job `agri_evidence_expiry` runs hourly at :07 (pg_cron 1.6.4 is installed on staging). Execute is revoked from `anon` and `authenticated`, so only the scheduler or an operator reaches it.
- Ledger actor roles now include `system`; migration `20261103001400_review_hardening.sql` is the only new migration. `supabase/apply-all.sql` is regenerated from 46 migrations.

### Verified
- **Staging SQL (transaction-scoped, rolled back):** self-grant blocked; roster and candidate reads refused without admin; grant/revoke; counts 0 outside scope and ≥1 for an all-scope authority; revoked reviewer loses the role and approval is refused; roster read refused for a non-admin; expiry first run 1 / second run 0; boundary `valid_until = p_now` expires; target deactivated; `system` ledger rows present; cron job active.
- **Browser (staging, temporary authority, clearly labelled fixtures):** Profile entry appears only for an authorised account; queue loads with scoped counts and the search/filter controls render; detail with source, applicability and review history; start review → source check → applicability check → approve (confirmation) → publish; expire with a reason; authority revoked mid-session, and a focus refresh removes the workspace. Urdu/RTL is verified at app level (`dir=rtl`, `lang=ur`, Urdu Profile); the reviewer workspace itself was not reopened in Urdu before cleanup.
- Typecheck, design lint, migration lint (46 migrations / 141 functions), Edge Function lint and `vite build` pass.
- App suite unchanged from the documented baseline: 9 files / 33 tests fail, 3 files / 64 pass. No new failure is attributable to 5.2.1.

### Not verified in this pass
- Reject, request-correction and supersede were not exercised through the UI; their server paths are unchanged from Phase 5.2, where they were covered by the staging suite. Search and status filters rendered but were not exercised in this pass.
- No real reviewer, official advisory source or agronomist threshold was appointed or activated. Active authorities are 0, so real approvals remain disabled.

### Cleanup
- Temporary admin capability, both review authorities, both labelled dossiers and the test knowledge entry were deleted. Staging is back to 0 evidence, 0 reviews, 0 active authorities and 0 admins. Audit rows written by the test actions remain in the audit log and are not editable.
