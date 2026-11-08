#!/usr/bin/env bash
#
# The Step 1 intake and the Step 2 verification loop, proved against a real
# Supabase Postgres.
#
# Steps 1 and 2 are properties of the *database* before they are properties of
# any screen: whether a report can be filed as somebody else, whether an expert
# can vouch outside their crops, whether a forecast can be served as an
# observation, whether a radius really gates eligibility. None of that can be
# established by reading the client, and the migration chain is one transaction
# the owner pastes by hand, so "the SQL is written" is not the same as "the SQL
# runs".
#
# What it does, from nothing:
#
#   1. starts a throwaway Supabase Postgres container — never a shared stack
#   2. creates the platform pieces Supabase provides and this repository does not
#      own: the roles, `auth.uid()`, and the storage schema the 0029 policies are
#      attached to
#   3. applies `supabase/apply-all.sql` in one transaction, exactly as pasted
#   4. provisions a farmer, a cotton expert, a wheat expert and an admin, driving
#      the expert through the *real* verification gate rather than inserting the
#      badge by hand
#   5. plays out Step 1 and Step 2 case by case, printing [OK] or the reason a
#      case did not behave as the rules say it must
#
# `--keep` leaves the container running for inspection; by default it is removed.
# Requires Docker. Nothing here touches a hosted project, and no credential is
# read or printed.
#
#   npm run db:bundle && bash scripts/verify-intel.sh

set -u

CONTAINER=farmer-app-intel
IMAGE=public.ecr.aws/supabase/postgres:17.6.1.159
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

AUTH_FARMER=11111111-1111-4111-8111-111111111111
AUTH_EXPERT=33333333-3333-4333-8333-333333333333
AUTH_EXPERT_WHEAT=44444444-4444-4444-8444-444444444444
AUTH_ADMIN=55555555-5555-4555-8555-555555555555

# Dera Ghazi Khan headquarters — the pilot's own coordinates.
DGK_LAT=30.0325
DGK_LON=70.6402
# Lahore, ~390 km away and outside the pilot division: the honest "far from it".
LHR_LAT=31.5497
LHR_LON=74.3436

failures=0
checks=0

cleanup() {
  if [ "$KEEP" -eq 0 ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1
  else
    echo
    echo "kept: docker exec -it $CONTAINER psql -U supabase_admin -d postgres"
  fi
}
trap cleanup EXIT

psql_root() { docker exec -i "$CONTAINER" psql -U supabase_admin -d postgres -X -q "$@"; }
psql_value() { docker exec "$CONTAINER" psql -U supabase_admin -d postgres -X -A -t -c "$1" 2>/dev/null | tr -d '\r'; }

# One statement, as one role, carrying a verified token's claims — which is what
# the API layer does for a signed-in farmer. VERBOSITY=verbose so a refusal shows
# its SQLSTATE, since "refused" and "refused with the right code" differ.
psql_claims() { # role, claims-json, sql
  local role="$1" claims="$2" sql="$3"
  docker exec -i "$CONTAINER" psql -U supabase_admin -d postgres -X -q -A -t \
    -v ON_ERROR_STOP=1 -v VERBOSITY=verbose \
    -c "set role $role;" \
    -c "set request.jwt.claims = '$claims';" \
    -c "$sql" 2>&1
}
psql_as() { # role, sub, sql
  psql_claims "$1" "{\"sub\":\"$2\"}" "$3"
}

case_out() { # label, allow|refuse, role, sub, sql
  local label="$1" expect="$2"; shift 2
  local out code verdict
  out="$(psql_as "$@")"
  code=$?
  verdict="OK"
  if [ "$expect" = "allow" ] && [ "$code" -ne 0 ]; then verdict="WRONG: refused"; failures=$((failures + 1)); fi
  if [ "$expect" = "refuse" ] && [ "$code" -eq 0 ]; then verdict="WRONG: allowed"; failures=$((failures + 1)); fi
  checks=$((checks + 1))
  printf '  %-16s %-56s %s\n' "[$verdict]" "$label" "$(echo "$out" | tr '\n' ' ' | cut -c1-96)"
}

expect_eq() { # label, actual, expected
  local label="$1" actual="$2" expected="$3"
  checks=$((checks + 1))
  if [ "$actual" = "$expected" ]; then
    printf '  %-16s %-56s %s\n' "[OK]" "$label" "$actual"
  else
    printf '  %-16s %-56s got '%s', expected '%s'\n' "[WRONG]" "$label" "$actual" "$expected"
    failures=$((failures + 1))
  fi
}

# A value read *as somebody*, for the cases where row level security answers with
# an empty set rather than a refusal. That is the difference between "cannot see"
# and "was stopped", and only one of them is what a policy actually does.
expect_as() { # label, role, sub, sql, expected
  local label="$1" role="$2" sub="$3" sql="$4" expected="$5"
  local actual
  actual="$(psql_as "$role" "$sub" "$sql" | tr -d '\n')"
  expect_eq "$label" "$actual" "$expected"
}

echo "=========== 1. a clean Supabase Postgres, never a shared stack ==========="
docker rm -f "$CONTAINER" >/dev/null 2>&1
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null || {
  echo "could not start $IMAGE — is Docker running?"
  exit 1
}

# The image bootstraps by starting Postgres, doing its init work, and restarting
# it. A single successful query therefore proves nothing — the first run of this
# harness raced that restart and applied the schema into a database that was on
# its way down. Readiness is the *second* "ready to accept connections" in the
# log, if the log says it, and a query that still answers after it.
ready=0
for _ in $(seq 1 150); do
  if [ "$(docker logs "$CONTAINER" 2>&1 | grep -c 'database system is ready to accept connections')" -ge 2 ] \
     && [ "$(psql_value 'select 1')" = "1" ]; then
    sleep 3
    if [ "$(psql_value 'select 1')" = "1" ]; then ready=1; break; fi
  fi
  sleep 1
done
if [ "$ready" -eq 1 ]; then echo "ready"; else
  echo "the database never came up:"; docker logs --tail 20 "$CONTAINER"; exit 1
fi

echo
echo "=========== 2. the platform pieces Supabase provides ==========="
psql_root -v ON_ERROR_STOP=1 <<'SQL'
create schema if not exists extensions;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon noinherit nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated noinherit nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role noinherit nologin bypassrls;
  end if;
end $$;

create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key,
  phone text
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid;
$$;

grant execute on function auth.uid() to anon, authenticated;

-- This image ships an older GoTrue schema than a live project has: the phone
-- columns and the confirmation timestamps are missing, and the chain reads them.
-- A hosted project already has them.
alter table auth.users
  add column if not exists phone              text,
  add column if not exists phone_confirmed_at timestamptz,
  add column if not exists email_confirmed_at timestamptz,
  add column if not exists phone_change       text,
  add column if not exists confirmed_at       timestamptz;

create schema if not exists storage;

create table if not exists storage.buckets (
  id              text primary key,
  name            text not null,
  public          boolean not null default false,
  file_size_limit bigint
);

-- `storage.objects` and `storage.foldername` are the storage-api's own objects,
-- created by the extension/bucket setup in a hosted project. Migration 0029
-- attaches four policies to them, so they have to exist before the chain runs.
create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text,
  name       text,
  owner      uuid,
  created_at timestamptz not null default now()
);

-- Supabase's own definition: the folder path, i.e. every component but the last.
create or replace function storage.foldername(name text)
returns text[]
language sql
immutable
as $$
  select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)];
$$;

grant usage on schema public, auth, storage to anon, authenticated;
grant usage on schema extensions to anon, authenticated, public;

-- A hosted project grants these and enables RLS on the storage tables itself. If
-- the shim skipped either, the storage cases below would test the shim instead of
-- the policies migration 0029 attaches.
grant select on storage.buckets to anon, authenticated;
grant select, insert, update, delete on storage.objects to anon, authenticated;
alter table storage.objects enable row level security;
SQL
echo "shim exit=$? (0 expected)"

echo
echo "=========== 3. supabase/apply-all.sql, as the owner will paste it ==========="
if ! grep -q '20261015000500_report_verification.sql' "$ROOT/supabase/apply-all.sql"; then
  echo "apply-all.sql does not contain the new migrations — run: npm run db:bundle"
  exit 1
fi
psql_root -v ON_ERROR_STOP=1 < "$ROOT/supabase/apply-all.sql" > /tmp/farmer-intel-apply.log 2>&1
bundle=$?
echo "bundle exit=$bundle (0 expected)"
if [ "$bundle" -ne 0 ]; then tail -12 /tmp/farmer-intel-apply.log; exit 1; fi
echo "tables=$(psql_value "select count(*) from pg_tables where schemaname = 'public'") \
with_rls=$(psql_value "select count(*) from pg_tables t where t.schemaname = 'public' and exists (select 1 from pg_class c where c.relname = t.tablename and c.relrowsecurity)") \
functions=$(psql_value "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'") \
buckets=$(psql_value "select string_agg(id, ',') from storage.buckets")"

echo
echo "=========== 4. four people: a farmer, two experts, an admin ==========="
psql_root -v ON_ERROR_STOP=1 -c "
insert into auth.users (id, phone, phone_confirmed_at, raw_user_meta_data) values
  ('$AUTH_FARMER',      '+923001112222', now(), '{\"display_name\":\"Farmer A\"}'::jsonb),
  ('$AUTH_EXPERT',      '+923001113333', now(), '{\"display_name\":\"Agronomist Cotton\"}'::jsonb),
  ('$AUTH_EXPERT_WHEAT','+923001114444', now(), '{\"display_name\":\"Agronomist Wheat\"}'::jsonb),
  ('$AUTH_ADMIN',       '+923001115555', now(), '{\"display_name\":\"Operations\"}'::jsonb)
on conflict (id) do nothing;" >/dev/null

FARMER="$(psql_value "select id from public.parties where auth_user_id = '$AUTH_FARMER'")"
EXPERT="$(psql_value "select id from public.parties where auth_user_id = '$AUTH_EXPERT'")"
EXPERT_WHEAT="$(psql_value "select id from public.parties where auth_user_id = '$AUTH_EXPERT_WHEAT'")"
ADMIN="$(psql_value "select id from public.parties where auth_user_id = '$AUTH_ADMIN'")"
echo "parties: farmer=$FARMER expert=$EXPERT wheat=$EXPERT_WHEAT admin=$ADMIN"

# Admin is a bootstrap act — there is no RPC that grants it, deliberately, so it
# is inserted here the way an operator would.
psql_root -v ON_ERROR_STOP=1 -c "
insert into public.party_capabilities (party_id, capability) values ('$ADMIN', 'admin')
on conflict (party_id, capability) do update set revoked_at = null;" >/dev/null

echo
echo "-- source reuse permission is an admin decision, not an inference --"
case_out "a farmer records source terms" refuse authenticated "$AUTH_FARMER" \
  "select code from public.agri_set_source_terms('uaf','granted','CC BY 4.0')"
case_out "an admin grants a licence with no name" refuse authenticated "$AUTH_ADMIN" \
  "select code from public.agri_set_source_terms('uaf','granted',null)"

echo
echo "-- unlicensed or unreviewed sources are not trusted retrieval --"
expect_eq "an unlicensed verified entry is excluded" \
  "$(psql_value "select count(*) from public.ai_knowledge_search('pink bollworm', 'cotton', null, 8, null) where slug = 'cotton-pink-bollworm-etl'")" "0"
expect_eq "a licensed editorial entry remains retrievable" \
  "$(psql_value "select count(*) from public.ai_knowledge_search('pink bollworm', 'cotton', null, 8, null) where slug = 'cotton-pink-bollworm'")" "1"

echo
echo "-- the expert is made an expert through the real gate, not by hand --"
# A verified contact is the PRD's first precondition, and a confirmed
# qualification is the second. Both are done here the way the product does them.
psql_root -v ON_ERROR_STOP=1 <<SQL >/dev/null
-- A verified contact is the PRD's first precondition for verification. The
-- signup trigger may already have written one, so this verifies whatever is
-- there rather than assuming which path created it.
insert into public.party_contacts (party_id, channel, value, raw_value, verified_at)
select v.party_id, 'phone', v.value, v.raw_value, now()
from (values
  ('$EXPERT'::uuid,       '923001113333', '+923001113333'),
  ('$EXPERT_WHEAT'::uuid, '923001114444', '+923001114444')
) as v(party_id, value, raw_value)
where not exists (
  select 1 from public.party_contacts c where c.party_id = v.party_id and c.channel = 'phone'
);

update public.party_contacts
   set verified_at = now()
 where party_id in ('$EXPERT', '$EXPERT_WHEAT')
   and verified_at is null;

insert into public.expert_applications (applicant_id, specialisations, crop_codes, experience_years, statement)
values
  ('$EXPERT', array['agronomy'], array['cotton'], 12, 'Cotton agronomy, twelve years of field advisory work in the DG Khan division.'),
  ('$EXPERT_WHEAT', array['agronomy'], array['wheat'], 9, 'Wheat agronomy, nine years of field advisory work in southern Punjab.')
on conflict do nothing;

insert into public.expert_qualifications (application_id, kind, title, issuer, identifier)
select a.id, 'degree', 'BSc Agriculture', 'University of Agriculture Faisalabad', 'UAF-' || left(a.reference, 8)
from public.expert_applications a
where not exists (select 1 from public.expert_qualifications q where q.application_id = a.id);
SQL

echo
# The badge cannot be granted on an unconfirmed claim. This is the gate the PRD
# describes, exercised before it is satisfied rather than after.
case_out "granting with no confirmed qualification" refuse authenticated "$AUTH_ADMIN" \
  "select 1 from public.grant_expert_verification((select id from public.expert_applications where applicant_id = '$EXPERT' and status = 'pending'), null, 'Board review')"

# The qualification has to be confirmed by a human before the grant will take —
# the refusal above is the gate working, and this is the gate being satisfied.
psql_root -v ON_ERROR_STOP=1 -c "
update public.expert_qualifications q
   set verified_at = now(), verified_by = '$ADMIN', verification_note = 'Certificate sighted'
 where q.verified_at is null;" >/dev/null

psql_as authenticated "$AUTH_ADMIN" "
select 1 from public.grant_expert_verification(
  (select id from public.expert_applications where applicant_id = '$EXPERT' and status = 'pending'), null, 'Board review')" >/dev/null
psql_as authenticated "$AUTH_ADMIN" "
select 1 from public.grant_expert_verification(
  (select id from public.expert_applications where applicant_id = '$EXPERT_WHEAT' and status = 'pending'), null, 'Board review')" >/dev/null

echo "experts now: $(psql_value "select string_agg(p.display_name || '=' || ev.status || ' ' || array_to_string(ev.crop_codes, '+'), ', ') from public.expert_verifications ev join public.parties p on p.id = ev.party_id")"
echo "capabilities: $(psql_value "select string_agg(p.display_name || ':' || c.capability, ', ') from public.party_capabilities c join public.parties p on p.id = c.party_id")"

echo
echo "=========== 5. Step 1 — intake, and what it refuses ==========="
case_out "guest files a report" refuse anon "" \
  "select id from public.submit_crop_report('cotton','pest','Leaf curling','Curling on the upper leaves since Tuesday.',$DGK_LAT,$DGK_LON,'Layyah','layyah')"

case_out "farmer files a report" allow authenticated "$AUTH_FARMER" \
  "select evidence || '/' || status from public.submit_crop_report('cotton','pest','Leaf curling','Curling on the upper leaves since Tuesday.',$DGK_LAT,$DGK_LON,'Layyah','layyah','now','fr-a')"

case_out "farmer files with a photo in their own folder" allow authenticated "$AUTH_FARMER" \
  "select photo_mime from public.submit_crop_report('cotton','disease','White spots','White spots on the bolls, about a tenth of the field.',$DGK_LAT,$DGK_LON,'Layyah','layyah','now','fr-b','$AUTH_FARMER/aaa.jpg','image/jpeg',204800)"

case_out "photo path in somebody else's folder" refuse authenticated "$AUTH_FARMER" \
  "select id from public.submit_crop_report('cotton','disease','Borrowed photo','Pointing at another farmer''s upload.',$DGK_LAT,$DGK_LON,'Layyah','layyah','now','fr-c','$AUTH_EXPERT/bbb.jpg','image/jpeg',2048)"

case_out "photo with a type that is not an image" refuse authenticated "$AUTH_FARMER" \
  "select id from public.submit_crop_report('cotton','disease','Wrong type','An executable is not a photo.',$DGK_LAT,$DGK_LON,'Layyah','layyah','now','fr-d','$AUTH_FARMER/ccc.exe','application/x-msdownload',2048)"

case_out "photo over the 15 MB cap" refuse authenticated "$AUTH_FARMER" \
  "select id from public.submit_crop_report('cotton','disease','Huge','Too large to accept.',$DGK_LAT,$DGK_LON,'Layyah','layyah','now','fr-e','$AUTH_FARMER/ddd.jpg','image/jpeg',20000000)"

case_out "the exact field location" refuse authenticated "$AUTH_FARMER" \
  "select id from public.submit_crop_report('cotton','pest','No area','A report with no area label at all.',$DGK_LAT,$DGK_LON,'','layyah','now','fr-f')"

case_out "the same report sent twice (idempotent)" allow authenticated "$AUTH_FARMER" \
  "select id from public.submit_crop_report('cotton','pest','Leaf curling','Curling on the upper leaves since Tuesday.',$DGK_LAT,$DGK_LON,'Layyah','layyah','now','fr-a')"

expect_eq "reports stored (rows, not attempts)" \
  "$(psql_value "select count(*) from public.crop_reports where reporter_id = '$FARMER'")" "2"
expect_eq "coordinates rounded to the ~1.1 km cell" \
  "$(psql_value "select extensions.ST_Y(geog::extensions.geometry)::text from public.crop_reports where idempotency_key = 'fr-a'")" "30.03"
expect_eq "every report starts unverified" \
  "$(psql_value "select count(*) from public.crop_reports where evidence = 'farmer_report'")" "2"

echo
echo "-- and a guest cannot reach the tables themselves --"
# Guests *can* read published public reports: that is the read path the app is
# built on, and the point is not that anon is blind but that it can only read,
# and only what is published.
# A report that is not published is not readable, which is what makes the guest
# read path a read path rather than a leak.
psql_root -c "
insert into public.crop_reports (crop_code, topic, title, body, geog, area_label, status, visibility)
values ('cotton','pest','Withheld report','Not for the feed.', extensions.ST_SetSRID(extensions.ST_MakePoint($DGK_LON,$DGK_LAT),4326)::extensions.geography, 'Layyah', 'pending', 'public');" >/dev/null
HIDDEN_REPORT="$(psql_value "select id from public.crop_reports where title = 'Withheld report'")"
expect_as "anon sees only published reports" anon "" "select count(*) from public.crop_reports" "2"
expect_as "and never the withheld one" anon "" \
  "select count(*) from public.crop_reports where id = '$HIDDEN_REPORT'" "0"
case_out "anon hand-writes a report" refuse anon "" \
  "insert into public.crop_reports (crop_code, topic, title, body, geog, area_label) values ('cotton','pest','x','y', extensions.ST_SetSRID(extensions.ST_MakePoint($DGK_LON,$DGK_LAT),4326)::extensions.geography,'Layyah')"
case_out "farmer hand-writes a report" refuse authenticated "$AUTH_FARMER" \
  "insert into public.crop_reports (crop_code, topic, title, body, geog, area_label) values ('cotton','pest','x','y', extensions.ST_SetSRID(extensions.ST_MakePoint($DGK_LON,$DGK_LAT),4326)::extensions.geography,'Layyah')"
case_out "anon uploads into the report bucket" refuse anon "" \
  "insert into storage.objects (bucket_id, name) values ('report-media','$AUTH_FARMER/zzz.jpg')"
case_out "a farmer uploads into another farmer's folder" refuse authenticated "$AUTH_FARMER" \
  "insert into storage.objects (bucket_id, name) values ('report-media','$AUTH_EXPERT/zzz.jpg')"
case_out "a farmer uploads into their own folder" allow authenticated "$AUTH_FARMER" \
  "insert into storage.objects (bucket_id, name) values ('report-media','$AUTH_FARMER/zzz.jpg')"
expect_as "a farmer sees none of another's objects" authenticated "$AUTH_FARMER" \
  "select count(*) from storage.objects where bucket_id = 'report-media' and name like '$AUTH_EXPERT/%'" "0"
expect_as "an expert sees the reviewer's whole bucket" authenticated "$AUTH_EXPERT" \
  "select count(*) from storage.objects where bucket_id = 'report-media'" "1"

echo
echo "=========== 6. Step 2 — the verification loop ==========="
psql_root -v ON_ERROR_STOP=1 <<SQL >/dev/null
-- Two official advisories, inserted the way the CSV importer writes them: a live
-- cotton pest advisory, and a wheat sowing one that must not match a cotton
-- report however hard a reviewer tries.
insert into public.agri_advisories (title, summary, crop_code, topic, district, area_label, published_at, valid_until, source_url, source_code)
values
  ('Pink bollworm advisory', 'Scout the crop weekly; act on a rising trap count over two consecutive weeks.', 'cotton', 'pest', 'Layyah', 'Layyah district', now() - interval '3 days', now() + interval '30 days', 'https://agripunjab.gov.pk/crop_advisory', 'punjab_advisory'),
  ('Wheat stem rust advisory', 'Scout wheat for rust; act before stripes reach the upper leaves.', 'wheat', 'pest', null, 'Punjab', now() - interval '2 days', now() + interval '40 days', 'https://agripunjab.gov.pk/crop_advisory', 'punjab_advisory'),
  ('Cotton irrigation advisory', 'Irrigate at squaring; missing water then costs more than at any later stage.', 'cotton', 'water', null, 'Punjab', now() - interval '2 days', now() + interval '20 days', 'https://agripunjab.gov.pk/crop_advisory', 'punjab_advisory'),
  ('Superseded bollworm advisory', 'Replaced by a newer bulletin.', 'cotton', 'pest', null, 'Punjab', now() - interval '60 days', now() - interval '30 days', 'https://agripunjab.gov.pk/crop_advisory', 'punjab_advisory');
SQL

REPORT_A="$(psql_value "select id from public.crop_reports where idempotency_key = 'fr-a'")"
REPORT_B="$(psql_value "select id from public.crop_reports where idempotency_key = 'fr-b'")"
COTTON_ADV="$(psql_value "select id from public.agri_advisories where title = 'Pink bollworm advisory'")"
WHEAT_ADV="$(psql_value "select id from public.agri_advisories where title = 'Wheat stem rust advisory'")"
WATER_ADV="$(psql_value "select id from public.agri_advisories where title = 'Cotton irrigation advisory'")"
STALE_ADV="$(psql_value "select id from public.agri_advisories where title = 'Superseded bollworm advisory'")"

case_out "the farmer tries to confirm their own report" refuse authenticated "$AUTH_FARMER" \
  "select evidence from public.verify_crop_report('$REPORT_A')"
case_out "the wheat expert confirms a cotton report" refuse authenticated "$AUTH_EXPERT_WHEAT" \
  "select evidence from public.verify_crop_report('$REPORT_A', 'Looks like bollworm to me')"
case_out "the cotton expert confirms it" allow authenticated "$AUTH_EXPERT" \
  "select evidence from public.verify_crop_report('$REPORT_A', 'Bollworm damage on the bolls, consistent with the advisory')"
case_out "confirming it a second time" refuse authenticated "$AUTH_EXPERT" \
  "select evidence from public.verify_crop_report('$REPORT_A', 'Again')"
case_out "matching it to an advisory afterwards" refuse authenticated "$AUTH_EXPERT" \
  "select evidence from public.match_report_to_advisory('$REPORT_A', '$COTTON_ADV', 'Also matches')"
case_out "a different expert withdraws the confirmation" refuse authenticated "$AUTH_EXPERT_WHEAT" \
  "select evidence from public.withdraw_report_verification('$REPORT_A', 'I disagree')"
case_out "the confirming expert withdraws it" allow authenticated "$AUTH_EXPERT" \
  "select evidence from public.withdraw_report_verification('$REPORT_A', 'Photo did not match the description')"

expect_eq "withdrawal returns it to unverified" \
  "$(psql_value "select evidence from public.crop_reports where id = '$REPORT_A'")" "farmer_report"
expect_eq "the withdrawal names what it withdrew" \
  "$(psql_value "select from_evidence || '->' || to_evidence from public.report_reviews where action = 'withdraw'")" "expert_verified->farmer_report"
expect_eq "the ledger has the whole history" \
  "$(psql_value "select string_agg(action, ',' order by created_at) from public.report_reviews where report_id = '$REPORT_A'")" "confirm_expert,withdraw"
expect_eq "the audit log recorded both acts" \
  "$(psql_value "select string_agg(action, ',' order by id) from public.audit_log where target_id = '$REPORT_A' and action like 'intel.%'")" "intel.report_confirmed,intel.report_verification_withdrawn"

echo
echo "-- the official path, and the rules that stop a match becoming decoration --"
case_out "matching cotton to a wheat pest advisory" refuse authenticated "$AUTH_EXPERT" \
  "select evidence from public.match_report_to_advisory('$REPORT_A', '$WHEAT_ADV', 'Close enough')"
case_out "matching cotton pest to a cotton water advisory" refuse authenticated "$AUTH_EXPERT" \
  "select evidence from public.match_report_to_advisory('$REPORT_A', '$WATER_ADV', 'Wrong topic')"
case_out "matching to an expired advisory" refuse authenticated "$AUTH_EXPERT" \
  "select evidence from public.match_report_to_advisory('$REPORT_A', '$STALE_ADV', 'Old bulletin')"
case_out "matching a disease report to a pest advisory" refuse authenticated "$AUTH_EXPERT" \
  "select evidence from public.match_report_to_advisory('$REPORT_B', '$COTTON_ADV', 'Wrong topic')"
case_out "matching a report to nothing at all" refuse authenticated "$AUTH_EXPERT" \
  "select evidence from public.match_report_to_advisory('$REPORT_A', gen_random_uuid(), 'Nothing')"
case_out "matching a report that is not published" refuse authenticated "$AUTH_EXPERT" \
  "select evidence from public.match_report_to_advisory('$HIDDEN_REPORT', '$COTTON_ADV', 'Not being served')"
case_out "matching a cotton pest report to the cotton pest advisory" allow authenticated "$AUTH_EXPERT" \
  "select evidence || '/' || (matched_advisory_id is not null)::text from public.match_report_to_advisory('$REPORT_A', '$COTTON_ADV', 'Same pest, same district')"
case_out "the farmer tries to withdraw the official match" refuse authenticated "$AUTH_FARMER" \
  "select evidence from public.withdraw_report_verification('$REPORT_A', 'I do not agree')"
case_out "the reviewer withdraws it, freeing the report" allow authenticated "$AUTH_EXPERT" \
  "select evidence from public.withdraw_report_verification('$REPORT_A', 'Superseded by a newer bulletin')"
case_out "and then confirms it with expertise instead" allow authenticated "$AUTH_EXPERT" \
  "select evidence from public.verify_crop_report('$REPORT_A', 'Confirmed from the photo')"

expect_eq "the report ends expert-verified, not official" \
  "$(psql_value "select evidence from public.crop_reports where id = '$REPORT_A'")" "expert_verified"
expect_eq "the withdrawn match left no pointer behind" \
  "$(psql_value "select (matched_advisory_id is null)::text from public.crop_reports where id = '$REPORT_A'")" "true"

echo
echo "-- the review queue --"
case_out "a farmer asks for the review queue" refuse authenticated "$AUTH_FARMER" \
  "select count(*) from public.report_review_queue($DGK_LAT, $DGK_LON, 500000, 50)"
case_out "the cotton expert asks for it" allow authenticated "$AUTH_EXPERT" \
  "select count(*) from public.report_review_queue($DGK_LAT, $DGK_LON, 500000, 50)"
expect_as "the queue holds only unverified reports" authenticated "$AUTH_EXPERT" \
  "select count(*) from (select * from public.report_review_queue($DGK_LAT, $DGK_LON, 500000, 50)) q join public.crop_reports r on r.id = q.id where r.evidence <> 'farmer_report'" "0"
expect_as "the queue holds only published reports" authenticated "$AUTH_EXPERT" \
  "select count(*) from (select * from public.report_review_queue($DGK_LAT, $DGK_LON, 500000, 50)) q join public.crop_reports r on r.id = q.id where r.status <> 'published'" "0"
case_out "the queue from 500 km away sees the report" allow authenticated "$AUTH_EXPERT" \
  "select count(*) from public.report_review_queue($LHR_LAT, $LHR_LON, 500000, 50)"
expect_as "the queue from 8 km away does not" authenticated "$AUTH_EXPERT" \
  "select count(*) from public.report_review_queue($LHR_LAT, $LHR_LON, 8000, 50)" "0"
expect_as "nor does it leak a coordinate" authenticated "$AUTH_EXPERT" \
  "select count(*) from public.report_review_queue($DGK_LAT, $DGK_LON, 500000, 50) where district is null" "0"

expect_as "the capability read answers with the basis" authenticated "$AUTH_EXPERT" \
  "select is_expert || '/' || is_admin || '/' || array_to_string(crop_codes, '+') from public.my_review_capability()" "true/false/cotton"
expect_as "and a wheat expert is not a cotton one" authenticated "$AUTH_EXPERT_WHEAT" \
  "select array_to_string(crop_codes, '+') from public.my_review_capability()" "wheat"

echo
echo "=========== 7. forecast risk — a risk, never an outbreak ==========="
psql_root -v ON_ERROR_STOP=1 -c "
insert into public.climate_forecasts (provider_code, district_code, forecast_on, issued_on, tmax_c, tmin_c, precip_mm, humidity_pct, wind_kph, raw)
values
  ('weatherapi','dera_ghazi_khan', current_date, current_date, 38.0, 26.0, 0.0, 42.0, 45.0, '{\"day\":{\"maxwind_kph\":45}}'::jsonb),
  ('weatherapi','layyah', current_date, current_date, 36.0, 25.0, 0.0, 40.0, 8.0, '{\"day\":{\"maxwind_kph\":8}}'::jsonb)
on conflict do nothing;" >/dev/null

expect_eq "the rule ships inert" \
  "$(psql_value "select is_active::text from public.forecast_risk_rules where code = 'spray-wind-too-strong'")" "false"

case_out "an expert activates a threshold" refuse authenticated "$AUTH_EXPERT" \
  "select code from public.activate_forecast_risk_rule('spray-wind-too-strong', 'Looks fine to me')"
case_out "an admin activates it without a reason" refuse authenticated "$AUTH_ADMIN" \
  "select code from public.activate_forecast_risk_rule('spray-wind-too-strong', '')"
# A reason is not evidence: the rule still has no reviewed dossier at this point.
case_out "an admin activates it without reviewed evidence" refuse authenticated "$AUTH_ADMIN" \
  "select code from public.activate_forecast_risk_rule('spray-wind-too-strong', 'The threshold looks operationally sensible')"
# The seed cites supplementary editorial text, which is why the case above must
# refuse. In this throwaway database only, the fixture is promoted through the
# same guards production uses: a published evidence dossier for the entry and
# one for the rule, each clearly labelled as harness data. This is not staging
# evidence, and the reviewer fields point at the harness admin solely because the
# table requires an identified reviewer. It is fixture setup, not an approval.
psql_root -v ON_ERROR_STOP=1 <<SQL
with entry as (
  select id from public.agri_knowledge_entries where slug = 'spray-wind'
), dossier as (
  insert into public.agri_evidence_items (
    evidence_key, target_kind, target_ref, version,
    source_organization, source_type, source_code, source_url,
    document_title, published_on, topic, classification, status,
    source_check_status, applicability_status, agronomic_status,
    submitted_by, submitted_at, reviewer_id, reviewed_at, review_note,
    valid_from, valid_until, published_at, created_by
  )
  select
    'harness-spray-wind-entry', 'knowledge_entry', entry.id::text, 1,
    'Punjab Agriculture Department', 'official_extension', 'punjab_agri',
    'https://agripunjab.gov.pk/',
    'Harness fixture: spray-wind entry', current_date, 'other',
    'official_government', 'published', 'authentic', 'applicable', 'approved',
    (select id from public.parties where auth_user_id = '$AUTH_ADMIN'), now(),
    (select id from public.parties where auth_user_id = '$AUTH_ADMIN'), now(),
    'Throwaway-database harness fixture, not a real review.',
    now() - interval '1 day', now() + interval '1 year', now(),
    (select id from public.parties where auth_user_id = '$AUTH_ADMIN')
  from entry
  returning id
)
update public.agri_knowledge_entries e
   set evidence_item_id = d.id,
       evidence_tier = 'verified',
       source_code = 'punjab_agri',
       source_url = 'https://agripunjab.gov.pk/',
       source_accessed_on = current_date
  from dossier d
 where e.slug = 'spray-wind';

insert into public.agri_evidence_items (
  evidence_key, target_kind, target_ref, version,
  source_organization, source_type, source_code, source_url,
  document_title, published_on, topic, classification, status,
  source_check_status, applicability_status, agronomic_status,
  submitted_by, submitted_at, reviewer_id, reviewed_at, review_note,
  valid_from, valid_until, published_at, created_by
)
values (
  'harness-spray-wind-rule', 'forecast_rule', 'spray-wind-too-strong', 1,
  'Punjab Agriculture Department', 'official_extension', 'punjab_agri',
  'https://agripunjab.gov.pk/',
  'Harness fixture: spray-wind rule', current_date, 'weather_damage',
  'official_government', 'published', 'authentic', 'applicable', 'approved',
  (select id from public.parties where auth_user_id = '$AUTH_ADMIN'), now(),
  (select id from public.parties where auth_user_id = '$AUTH_ADMIN'), now(),
  'Throwaway-database harness fixture, not a real review.',
  now() - interval '1 day', now() + interval '1 year', now(),
  (select id from public.parties where auth_user_id = '$AUTH_ADMIN')
);

update public.forecast_risk_rules r
   set evidence_item_id = (
     select id from public.agri_evidence_items
      where evidence_key = 'harness-spray-wind-rule')
 where r.code = 'spray-wind-too-strong';
SQL

expect_eq "the fixture promotion is in place" \
  "$(psql_value "select evidence_tier || '/' || (source_url is not null)::text || '/' || (evidence_item_id is not null)::text from public.agri_knowledge_entries where slug = 'spray-wind'")" "verified/true/true"

EVIDENCE_ID="$(psql_value "select id from public.agri_evidence_items where evidence_key = 'harness-spray-wind-entry'")"
case_out "a farmer publishes evidence" refuse authenticated "$AUTH_FARMER" \
  "select status from public.agri_publish_evidence('$EVIDENCE_ID', null)"
case_out "a farmer withdraws published evidence" refuse authenticated "$AUTH_FARMER" \
  "select status from public.agri_withdraw_evidence('$EVIDENCE_ID', 'I disagree')"
case_out "an admin activates it with a reason" allow authenticated "$AUTH_ADMIN" \
  "select is_active::text from public.activate_forecast_risk_rule('spray-wind-too-strong', 'Extension guidance: do not spray above 20 km/h; signed off by the division agronomist')"

case_out "a signed-in farmer runs the generator" refuse authenticated "$AUTH_FARMER" \
  "select public.generate_forecast_risks()"
case_out "the admin runs the generator" allow authenticated "$AUTH_ADMIN" \
  "select public.generate_forecast_risks(current_date, current_date)"

expect_eq "a windy district produced a risk, the calm one did not" \
  "$(psql_value "select string_agg(district_code, ',' order by district_code) from public.forecast_risks")" "dera_ghazi_khan"
expect_eq "the evidence is on the row" \
  "$(psql_value "select metric || ' ' || operator || ' ' || threshold || ' (observed ' || observed_value || ')' from public.forecast_risks")" "wind_kph gt 20 (observed 45.0)"
expect_eq "it carries its citation" \
  "$(psql_value "select count(*) from public.forecast_risks k join public.forecast_risk_rules r on r.code = k.rule_code join public.agri_knowledge_entries e on e.id = r.knowledge_entry_id where e.is_published and e.slug = 'spray-wind'")" "1"
expect_eq "the wording says risk, not outbreak" \
  "$(psql_value "select (title ilike '%not a forecast of damage%')::text || '/' || (summary ilike '%Risk, not an outbreak%')::text from public.forecast_risks")" "true/true"
expect_eq "and it is served in both languages" \
  "$(psql_value "select (title_ur is not null and summary_ur is not null)::text from public.forecast_risks")" "true"

echo
echo "-- re-running the same day is an upsert, not a duplicate --"
psql_as authenticated "$AUTH_ADMIN" "select public.generate_forecast_risks(current_date, current_date)" >/dev/null
expect_eq "row count after a second run" "$(psql_value "select count(*) from public.forecast_risks")" "1"

echo
echo "-- and the feed serves it as a risk, gated by geography --"
expect_eq "a risk row reaches the feed" \
  "$(psql_value "select kind || '/' || evidence from public.intel_feed($DGK_LAT, $DGK_LON, 8000, null, null, 50) where kind = 'risk'")" "risk/forecast_risk"
expect_eq "a farm 8 km from Lahore sees no DG Khan risk" \
  "$(psql_value "select count(*) from public.intel_feed($LHR_LAT, $LHR_LON, 8000, null, null, 50) where kind = 'risk'")" "0"
expect_eq "the same farm at 500 km does" \
  "$(psql_value "select count(*) from public.intel_feed($LHR_LAT, $LHR_LON, 500000, null, null, 50) where kind = 'risk'")" "1"
expect_eq "the risk row names its district, not a coordinate" \
  "$(psql_value "select area_label || '/' || (distance_m is not null)::text from public.intel_feed($DGK_LAT, $DGK_LON, 8000, null, null, 50) where kind = 'risk'")" "Dera Ghazi Khan/true"
psql_root -c "update public.forecast_risks set expires_at = now() - interval '1 hour';" >/dev/null
expect_eq "an expired risk leaves the feed" \
  "$(psql_value "select count(*) from public.intel_feed($DGK_LAT, $DGK_LON, 8000, null, null, 50) where kind = 'risk'")" "0"

echo
if [ "$failures" -eq 0 ]; then
  echo "intel: every one of $checks cases behaved as the rules say it must"
else
  echo "intel: $failures of $checks case(s) did NOT behave as the rules say"
fi
exit "$failures"
