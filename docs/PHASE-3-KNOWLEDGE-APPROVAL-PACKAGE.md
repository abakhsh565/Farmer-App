# Phase 3 — Knowledge source and evidence approval package

Date: 2026-11-06
Status: **approval required; no approval has been recorded by this package.**

This is the human decision package for the knowledge lifecycle work. It names
the sources, the entries they affect, the exact records an authorised person
must create, and the decisions that remain blocked. It does not invent a
reviewer, a licence, a publication date, an agronomist, or a threshold.

The staging lifecycle migration `20261105000100` is applied, and the
source-permission gate added after that version was recorded is applied
forward-only as `20261108130627`. The `permission_status` and `license_name`
columns are persisted in staging; the values below were read back on
2026-11-08. They record the current decisions and the approvals still required —
they are not an approval.

## 1. What is in the corpus

The seeded corpus contains five sources and eight published entries.

| Source code | Publisher | Entry count | Current permission decision | Licence / decision required |
| --- | --- | ---: | --- | --- |
| `app_editorial` | Farmer App | 7 | `not_required` after `20261105000100` | `Farmer App internal editorial content`. This is internal material, not external evidence. |
| `punjab_agri` | Agriculture Department, Government of the Punjab; <https://agripunjab.gov.pk/pw_economic> | 1 | `unknown` | `Government of Punjab website content; reuse permission not recorded`. Written reuse permission or a verified open licence is required before this source can be trusted. |
| `uaf` | University of Agriculture, Faisalabad; <https://uaf.edu.pk/> | 0 | `unknown` / candidate | No specific publication, permission, licence or entry. Not approvable as-is. |
| `dpp` | Department of Plant Protection, Government of Pakistan | 0 | `unknown` / candidate | No stable public reference or specific publication recorded. Not approvable as-is. |
| `cabi_plantwise` | CABI PlantwisePlus Knowledge Bank; <https://plantwiseplusknowledgebank.org/> | 0 | `unknown` / candidate | No specific publication or reuse permission recorded. Supplementary only; not approvable as-is. |

The seven `app_editorial` entries are:

1. `cotton-pink-bollworm`
2. `cotton-whitefly`
3. `wheat-sowing-window`
4. `wheat-yellow-rust`
5. `spray-wind`
6. `irrigation-timing`
7. `fertiliser-nitrogen-split`

They are **supplementary** editorial summaries. They are not official guidance,
have no source evidence dossier, and must not be promoted to `verified` by
assertion.

The one `punjab_agri` entry is `cotton-pink-bollworm-etl` (version 1). It is
currently marked `verified` in the seed, but it has **no published evidence
dossier**. A tier label on a legacy row is not a human review. Until a real
reviewer publishes a dossier for it, the source gate in `20261105000100`
excludes it from trusted retrieval.

The separate `spray-wind-too-strong` forecast rule is **inactive**. Its 30 kph
threshold has no evidence-backed agronomist sign-off. The throwaway-harness
promotion is fixture setup only and is not staging approval. It must remain
inactive.

## 2. Decisions required

### 2.1 `app_editorial`

**Decision:** accept as internal supplementary content, or submit every entry
for agronomic review if it is to be treated as more than editorial context.

- The source does not require a third-party reuse licence.
- The existing `not_required` setting and internal licence name may be retained.
- No editorial entry may be labelled `verified` or used for chemical/dose advice
  without a published dossier and a named reviewer.
- If an agronomist reviews an editorial entry, record a real dossier with the
  reviewer, review note, and validity window; do not edit the tier by hand.

### 2.2 `punjab_agri` — the blocking decision

**Decision:** obtain and record a real reuse permission, or remove the entry from
trusted use.

The operator must obtain one of:

- a written permission from the publisher that names the reuse scope, or
- a verified open licence that covers the page and the intended use.

Then record the decision through the admin RPC:

```sql
select public.agri_set_source_terms(
  'punjab_agri',
  'granted',                       -- only with a real permission/licence
  '<exact licence or permission name>',
  'https://<direct licence or permission URL>',
  <freshness_days or null>,
  '<who granted it, when, and the scope>'
);
```

Do **not** call this with `granted` merely because the publisher is a government
department. Institutional reputation is not a reuse licence. If permission
cannot be obtained, leave the source `unknown` and ensure the entry is not
published as verified; the local source gate already excludes it.

Even after permission is granted, `cotton-pink-bollworm-etl` still needs a
published dossier before it is trusted as verified.

### 2.3 `uaf`, `dpp`, `cabi_plantwise`

These are candidate sources only. They are **not approvable** until a named
person selects a specific document, records the publisher permission/licence,
and creates an evidence dossier for it. Do not create an empty source approval,
a generic "institution is credible" note, or a dossier without a real document.

## 3. Reviewer and publisher authority

Staging currently has **0 active review authorities**, **0 evidence dossiers**
and **0 reviews**. There is no named `evidence_reviewer` or `content_manager`.
The role model deliberately separates the two acts:

- `evidence_reviewer` checks source authenticity, applicability and agronomy.
- `content_manager` publishes already-approved evidence and targets.
- `admin` may grant authority but is not automatically either role.

The operator must record real people in `public.agri_review_authorities`:

| Field | Required value |
| --- | --- |
| `party_id` | The named person's real `parties.id`; never a fixture or a placeholder. |
| `authority` | `evidence_reviewer` and/or `content_manager`. |
| `scope_crops` | Crop codes the person is qualified for; empty only for a national/lead role. |
| `scope_districts` | Districts covered; empty only for a national/lead role. |
| `granted_by` | The admin party who made the appointment. |
| `note` | The basis for the appointment and its scope. |

Use two rows when one person holds both authorities. Segregation of review and
publication is preferred. No authority is created by this document.

## 4. Evidence dossier required for the verified entry

For `cotton-pink-bollworm-etl`, the reviewer needs a real dossier in
`public.agri_evidence_items` with:

| Field | Required content |
| --- | --- |
| `target_kind` | `knowledge_entry` |
| `target_ref` | The UUID of the published entry, not the slug. |
| `version` | The exact entry version under review. |
| `source_code` | `punjab_agri` |
| `source_organization` | The publisher named on the document. |
| `source_type` | `official_extension` |
| `source_url` | The exact HTTPS document/page URL checked. |
| `document_title` | The document's real title. |
| `published_on` | The document's real publication date; do not guess. |
| `accessed_at` | The date the reviewer actually accessed it. |
| `source_check_status` | `authentic` only after the document is checked. |
| `applicability_status` | `applicable` only for the named crop/region. |
| `agronomic_status` | `approved` only after agronomic review. |
| `reviewer_id` | The named `evidence_reviewer` party. |
| `reviewed_at` | The actual review time. |
| `review_note` | What was checked and any limitation. |
| `valid_from` / `valid_until` | A bounded validity window; no open-ended approval. |
| `classification` | A real classification, not `unverified_submission`. |

The existing table constraints refuse `approved`/`published` without the
authentic/applicable/agronomic checks, a reviewer, a review time, a validity
window, and a non-unverified classification. The content manager then publishes
with `agri_publish_evidence`; a reviewer cannot publish, and a content manager
cannot substitute for the agronomic review.

If the document cannot supply a real title, date, or applicability, the correct
outcome is **not approved**, not a guessed dossier.

## 5. Publication, withdrawal and expiry checks

After the migration is applied, the authorised operator must observe:

- a source with `unknown` or `needs_permission` cannot be ingested;
- a `granted`/`not_required` source requires a non-empty licence name;
- a draft or unreviewed dossier cannot make a target published/verified/active;
- withdrawal unpublishes the linked knowledge entry, removes its recommendation
  pointer, and leaves an append-only review/audit record;
- an expired or withdrawn entry is absent from retrieval and the served feed;
- the local source gate excludes the legacy unlicensed `punjab_agri` entry and
  any `verified` entry without a published reviewed dossier.

The local source gate was added to the pending migration on 2026-11-06. The
throwaway-Postgres intelligence harness passes **78/78** cases, including the
unlicensed-entry exclusion. That 78/78 directly exercises retrieval; the
recommendation-feed wrapper compiles in the full schema apply but its behavior
was not separately exercised. This is local evidence only; staging cannot show
it until `20261105000100` is applied and the AI/feed code is deployed.

## 6. Sign-off sheet

This sheet is deliberately blank. It is the record the human approvers must
complete; it is not an approval.

| Source | Decision (`granted` / `needs_permission` / `unknown` / `not_required`) | Exact licence or permission | URL | Reviewer name and party ID | Content manager name and party ID | Date | Affected entries | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `app_editorial` |  | Farmer App internal editorial content | — |  |  |  | seven editorial slugs above |  |
| `punjab_agri` |  |  |  |  |  |  | `cotton-pink-bollworm-etl` |  |
| `uaf` |  |  |  |  |  |  | none yet | specific document required |
| `dpp` |  |  |  |  |  |  | none yet | specific document required |
| `cabi_plantwise` |  |  |  |  |  |  | none yet | specific document required |

Agronomist threshold sign-off (separate decision):

| Rule | Current state | Decision | Signatory | Date | Evidence |
| --- | --- | --- | --- | --- | --- |
| `spray-wind-too-strong` | inactive; 30 kph unsupported | keep inactive until a published dossier and written sign-off exist |  |  |  |

## 7. Exact blocker statement

Phase 3 human approval is **blocked** because no named reviewer or content
manager exists, no source permission/licence is recorded for `punjab_agri`, the
legacy verified entry has no published dossier, and no agronomist has signed off
the wind threshold. These are external human decisions; they cannot be created
by code, a fixture, or this report.
