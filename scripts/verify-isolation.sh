#!/usr/bin/env bash
#
# Two-account isolation, proved against a real Supabase Postgres.
#
# Phase 1 of the go-live plan is "real user accounts": authentication, sessions,
# identity, permissions and secure data access. The first four are visible in the
# app and covered by the suites. The last one is not: whether farmer B can reach
# farmer A's data is a property of the *database*, and no amount of client code
# makes it true. So it is checked here, against the schema this repository
# actually ships, with two authenticated users and A's token in B's hands.
#
# What it does, from nothing:
#
#   1. starts a throwaway Supabase Postgres container (the same image family the
#      hosted product runs) — never a shared or running stack
#   2. creates the platform-level pieces Supabase provides and this repository
#      does not own: the roles, `auth.uid()`, and the storage bucket table
#   3. applies `supabase/apply-all.sql` — the same bytes the owner pastes into the
#      project's SQL editor — in one transaction, and reports the counts
#   4. provisions two farmers through the `auth.users` trigger, then plays out
#      the cases that decide whether accounts are actually isolated
#
# Every case prints [OK] or a reason it is not: a refused statement that should
# have been allowed, or the reverse. `--keep` leaves the container running so the
# data can be inspected; by default it is removed at the end.
#
# Requires Docker. Nothing here touches a hosted project, and no credential is
# read or printed.
#
#   bash scripts/verify-isolation.sh

set -u

CONTAINER=farmer-app-isolation
IMAGE=public.ecr.aws/supabase/postgres:17.6.1.159
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

AUTH_A="11111111-1111-4111-8111-111111111111"
AUTH_B="22222222-2222-4222-8222-222222222222"

failures=0

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
psql_value() { docker exec "$CONTAINER" psql -U supabase_admin -d postgres -X -A -t -c "$1" 2>/dev/null; }

# One statement, as one role, carrying a verified-token's claims — which is what
# the API layer does for a signed-in farmer. VERBOSITY=verbose so a refusal shows
# its SQLSTATE, since "refused" and "refused with the right code" differ.
psql_as() { # role, sub-or-empty, sql
  local role="$1" sub="$2" sql="$3"
  docker exec -i "$CONTAINER" psql -U supabase_admin -d postgres -X -q -A -t \
    -v ON_ERROR_STOP=1 -v VERBOSITY=verbose \
    -c "set role $role;" \
    -c "set request.jwt.claims = '{\"sub\":\"$sub\"}';" \
    -c "$sql" 2>&1
}

case_out() { # label, allow|refuse, role, sub, sql
  local label="$1" expect="$2"; shift 2
  local out code verdict
  out="$(psql_as "$@")"
  code=$?
  verdict="OK"
  if [ "$expect" = "allow" ] && [ "$code" -ne 0 ]; then verdict="WRONG: refused"; failures=$((failures + 1)); fi
  if [ "$expect" = "refuse" ] && [ "$code" -eq 0 ]; then verdict="WRONG: allowed"; failures=$((failures + 1)); fi
  printf '%-14s %-52s %s\n' "[$verdict]" "$label" "$(echo "$out" | tr '\n' ' ' | cut -c1-110)"
}

echo "=========== 1. a clean Supabase Postgres, never a shared stack ==========="
docker rm -f "$CONTAINER" >/dev/null 2>&1
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null || {
  echo "could not start $IMAGE — is Docker running?"
  exit 1
}

# The image restarts Postgres once while bootstrapping, so an accepting socket is
# not readiness: ask for a result, twice, a moment apart.
ready=0
for _ in $(seq 1 120); do
  if [ "$(psql_value 'select 1')" = "1" ]; then
    sleep 2
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

-- Supabase's own definition: the caller's auth user id, from the verified JWT
-- claims the API layer puts on the connection.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid;
$$;

grant execute on function auth.uid() to anon, authenticated;

-- This image ships an older GoTrue schema than a live project has: the phone
-- columns and the confirmation timestamps are missing, and the migration chain
-- reads them (a contact's verified_at comes from the provider's own
-- confirmation). A hosted project already has them.
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

-- The storage API installs these objects in a hosted project. Migration 0029
-- attaches the report-media policies to storage.objects, so the throwaway
-- database must provide the same surface before applying the bundle.
create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text,
  name       text,
  owner      uuid,
  created_at timestamptz not null default now()
);

create or replace function storage.foldername(name text)
returns text[]
language sql
immutable
as $$
  select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)];
$$;

grant usage on schema storage to anon, authenticated;
grant select on storage.buckets to anon, authenticated;
grant select, insert, update, delete on storage.objects to anon, authenticated;
alter table storage.objects enable row level security;

grant usage on schema public, auth to anon, authenticated;
grant usage on schema extensions to anon, authenticated, public;
SQL
echo "shim exit=$? (0 expected)"

echo
echo "=========== 3. supabase/apply-all.sql, as the owner will paste it ==========="
psql_root -v ON_ERROR_STOP=1 < "$ROOT/supabase/apply-all.sql" > /tmp/farmer-isolation-apply.log 2>&1
bundle=$?
echo "bundle exit=$bundle (0 expected)"
if [ "$bundle" -ne 0 ]; then tail -12 /tmp/farmer-isolation-apply.log; exit 1; fi
echo "tables=$(psql_value "select count(*) from pg_tables where schemaname = 'public'") \
with_rls=$(psql_value "select count(*) from pg_tables t where t.schemaname = 'public' and exists (select 1 from pg_class c where c.relname = t.tablename and c.relrowsecurity)") \
functions=$(psql_value "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'")"

echo
echo "=========== 4. two farmers, provisioned by the auth.users trigger ==========="
psql_root -v ON_ERROR_STOP=1 -c "
insert into auth.users (id, phone, phone_confirmed_at, raw_user_meta_data) values
  ('$AUTH_A', '+923001112222', now(), '{\"display_name\":\"Farmer A\"}'::jsonb),
  ('$AUTH_B', '+923003334444', now(), '{\"display_name\":\"Farmer B\"}'::jsonb)
on conflict (id) do nothing;" >/dev/null
docker exec "$CONTAINER" psql -U supabase_admin -d postgres -X -A -t -c "
select p.display_name || ' -> party ' || p.id || ', profiles ' ||
       (select count(*) from public.farmer_profiles f where f.party_id = p.id) ||
       ', contacts ' || (select count(*) from public.party_contacts c where c.party_id = p.id)
from public.parties p order by p.display_name"

A_PARTY="$(psql_value "select id from public.parties where auth_user_id = '$AUTH_A'")"
B_PARTY="$(psql_value "select id from public.parties where auth_user_id = '$AUTH_B'")"

echo
echo "=========== 5. the cases that decide it ==========="
case_out "A writes its own document"            allow  authenticated "$AUTH_A" "select revision from public.client_document_put('$A_PARTY','community','{\"v\":1}'::jsonb)"
case_out "A writes it again — revision advances" allow authenticated "$AUTH_A" "select revision from public.client_document_put('$A_PARTY','community','{\"v\":2}'::jsonb)"
case_out "A writes with a stale revision"       refuse authenticated "$AUTH_A" "select revision from public.client_document_put('$A_PARTY','community','{\"v\":3}'::jsonb, 1)"

echo
echo "-- B, holding A's party id --"
case_out "B reads A's document"                 refuse authenticated "$AUTH_B" "select document from public.client_document_get('$A_PARTY','community')"
case_out "B writes A's document"                refuse authenticated "$AUTH_B" "select revision from public.client_document_put('$A_PARTY','community','{\"v\":99}'::jsonb)"
case_out "B deletes A's document"               refuse authenticated "$AUTH_B" "select public.client_document_delete('$A_PARTY','community')"
case_out "B reads its own, which is empty"      allow  authenticated "$AUTH_B" "select count(*) from public.client_document_get('$B_PARTY','community')"

echo
echo "-- B, against the table itself (row level security) --"
case_out "B selects A's rows directly"          allow  authenticated "$AUTH_B" "select count(*) from public.client_documents where owner_id = '$A_PARTY'"
case_out "B inserts a row owned by A"           refuse authenticated "$AUTH_B" "insert into public.client_documents (owner_id, collection, document) values ('$A_PARTY','session','{}'::jsonb)"
case_out "B selects every document"             allow  authenticated "$AUTH_B" "select count(*) from public.client_documents"
case_out "A selects every document"             allow  authenticated "$AUTH_A" "select count(*) from public.client_documents"
case_out "B reads A's party row"                allow  authenticated "$AUTH_B" "select count(*) from public.parties where id = '$A_PARTY'"

echo
echo "-- a session with no identity, and a guest --"
case_out "no claims at all reads A's document"  refuse authenticated ""        "select document from public.client_document_get('$A_PARTY','community')"
case_out "anon selects the documents table"     refuse anon          ""        "select count(*) from public.client_documents"
case_out "anon writes a document"               refuse anon          ""        "insert into public.client_documents (owner_id, collection, document) values ('$A_PARTY','session','{}'::jsonb)"

echo
echo "=========== 6. and A's document is exactly as A left it ==========="
docker exec "$CONTAINER" psql -U supabase_admin -d postgres -X -A -t -c "
select 'owner=' || p.display_name || ' document=' || d.document::text || ' revision=' || d.revision
from public.client_documents d join public.parties p on p.id = d.owner_id"

echo
if [ "$failures" -eq 0 ]; then
  echo "isolation: every case behaved as the rules say it must"
else
  echo "isolation: $failures case(s) did NOT behave as the rules say"
fi
exit "$failures"
