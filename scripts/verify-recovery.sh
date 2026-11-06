#!/usr/bin/env bash
#
# Phase 8 · backup and recovery verification, on a disposable database.
#
# A backup is not evidence. A dump file that has never been restored is a hope.
# This harness proves the whole round trip:
#
#   1. build a disposable Supabase Postgres with the real bundled schema and
#      representative farmer, crop, forecast, AI and knowledge rows;
#   2. take a custom-format `pg_dump`;
#   3. restore it into a *different* database and compare schema, RLS, policy,
#      function, foreign-key and critical-row fingerprints;
#   4. exercise RLS and the critical RPCs against the restored copy as the same
#      farmer identities;
#   5. prove that a partial restore and a killed restore are detected as
#      incomplete, and that a clean re-restore recovers from the killed one;
#   6. prove that restoring over a live copy is refused unless it is cleaned.
#
# Nothing here reads a credential or touches staging/production. The only target
# is a local Docker container. `--keep` leaves it for inspection.
#
#   npm run db:bundle && bash scripts/verify-recovery.sh

set -u

# Git Bash rewrites container paths like /tmp/farmer.dump into Windows paths
# before Docker sees them. The dump lives inside the container; stop the rewrite.
export MSYS_NO_PATHCONV=1

CONTAINER=farmer-app-recovery
IMAGE=public.ecr.aws/supabase/postgres:17.6.1.159
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

AUTH_A=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
AUTH_B=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb

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

psql_db() { # database, sql
  docker exec "$CONTAINER" psql -U supabase_admin -d "$1" -X -A -t -c "$2" 2>/dev/null | tr -d '\r'
}
psql_root() { docker exec -i "$CONTAINER" psql -U supabase_admin -d postgres -X -q "$@"; }
psql_as() { # database, role, sub, sql
  local db="$1" role="$2" sub="$3" sql="$4"
  docker exec -i "$CONTAINER" psql -U supabase_admin -d "$db" -X -q -A -t \
    -v ON_ERROR_STOP=1 -v VERBOSITY=verbose \
    -c "set role $role;" \
    -c "set request.jwt.claims = '{\"sub\":\"$sub\"}';" \
    -c "$sql" 2>&1
}

expect_eq() { # label, actual, expected
  local label="$1" actual="$2" expected="$3"
  checks=$((checks + 1))
  if [ "$actual" = "$expected" ]; then
    printf '  %-18s %-58s %s\n' "[OK]" "$label" "$actual"
  else
    printf '  %-18s %-58s got '\''%s'\'', expected '\''%s'\''\n' "[WRONG]" "$label" "$actual" "$expected"
    failures=$((failures + 1))
  fi
}

case_out() { # label, allow|refuse, database, role, sub, sql
  local label="$1" expect="$2"; shift 2
  local out code verdict
  out="$(psql_as "$@")"
  code=$?
  verdict="OK"
  if [ "$expect" = "allow" ] && [ "$code" -ne 0 ]; then verdict="WRONG: refused"; failures=$((failures + 1)); fi
  if [ "$expect" = "refuse" ] && [ "$code" -eq 0 ]; then verdict="WRONG: allowed"; failures=$((failures + 1)); fi
  checks=$((checks + 1))
  printf '  %-18s %-58s %s\n' "[$verdict]" "$label" "$(echo "$out" | tr '\n' ' ' | cut -c1-96)"
}

# One line that changes if the schema, security surface, data or referential
# integrity changes. It is deliberately readable: a mismatch says which part.
snapshot() { # database
  psql_db "$1" "
    select
      (select count(*) from pg_tables where schemaname = 'public') || '|' ||
      (select count(*) from pg_tables t where t.schemaname = 'public'
         and exists (select 1 from pg_class c where c.relname = t.tablename and c.relrowsecurity)) || '|' ||
      (select count(*) from pg_policies where schemaname = 'public') || '|' ||
      (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public') || '|' ||
      (select count(*) from public.agri_knowledge_entries) || '|' ||
      (select count(*) from public.crop_catalog) || '|' ||
      (select count(*) from public.parties) || '|' ||
      (select count(*) from public.crop_instances) || '|' ||
      (select count(*) from public.climate_forecasts) || '|' ||
      (select count(*) from public.ai_request_events) || '|' ||
      (select count(*) from pg_constraint where contype = 'f' and not convalidated) || '|' ||
      (select md5(coalesce(string_agg(slug || ':' || version, ',' order by slug, version), ''))
         from public.agri_knowledge_entries)"
}

echo "=========== 1. a clean disposable Supabase Postgres ==========="
# Public registries rate-limit shared CI egress. Retry the pull/start boundedly;
# a persistent failure is still a failure, not a skipped recovery drill.
started=0
for attempt in 1 2 3 4 5 6; do
  docker rm -f "$CONTAINER" >/dev/null 2>&1
  if docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null 2>/tmp/farmer-recovery-docker.log; then
    started=1
    break
  fi
  echo "container start attempt $attempt failed: $(tail -1 /tmp/farmer-recovery-docker.log)"
  sleep $((attempt * 10))
done
if [ "$started" -ne 1 ]; then
  echo "could not start $IMAGE after retries — is Docker running?"; exit 1
fi

ready=0
for _ in $(seq 1 150); do
  if [ "$(docker logs "$CONTAINER" 2>&1 | grep -c 'database system is ready to accept connections')" -ge 2 ] \
     && [ "$(psql_db postgres 'select 1')" = "1" ]; then
    sleep 3
    if [ "$(psql_db postgres 'select 1')" = "1" ]; then ready=1; break; fi
  fi
  sleep 1
done
if [ "$ready" -eq 1 ]; then echo "ready"; else
  echo "the database never came up:"; docker logs --tail 20 "$CONTAINER"; exit 1
fi

echo
echo "=========== 2. platform roles and the schemas the chain expects ==========="
psql_root -v ON_ERROR_STOP=1 <<'SQL'
create schema if not exists extensions;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon noinherit nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated noinherit nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role noinherit nologin bypassrls; end if;
end $$;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, phone text);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid;
$$;
grant execute on function auth.uid() to anon, authenticated;
alter table auth.users
  add column if not exists phone text,
  add column if not exists phone_confirmed_at timestamptz,
  add column if not exists email_confirmed_at timestamptz,
  add column if not exists phone_change text,
  add column if not exists confirmed_at timestamptz;
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key, name text not null, public boolean not null default false, file_size_limit bigint
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid,
  created_at timestamptz not null default now()
);
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)];
$$;
grant usage on schema public, auth, storage to anon, authenticated;
grant usage on schema extensions to anon, authenticated, public;
grant select on storage.buckets to anon, authenticated;
grant select, insert, update, delete on storage.objects to anon, authenticated;
alter table storage.objects enable row level security;
SQL
echo "shim exit=$? (0 expected)"

echo
echo "=========== 3. the real bundled schema ==========="
if ! grep -q '20261105000200_ai_gateway_controls.sql' "$ROOT/supabase/apply-all.sql"; then
  echo "apply-all.sql is stale — run: npm run db:bundle"; exit 1
fi
psql_root -v ON_ERROR_STOP=1 < "$ROOT/supabase/apply-all.sql" > /tmp/farmer-recovery-apply.log 2>&1
bundle=$?
echo "bundle exit=$bundle (0 expected)"
if [ "$bundle" -ne 0 ]; then tail -12 /tmp/farmer-recovery-apply.log; exit 1; fi

echo
echo "=========== 4. representative rows before the backup ==========="
psql_root -v ON_ERROR_STOP=1 -c "
insert into auth.users (id, phone, phone_confirmed_at, raw_user_meta_data) values
  ('$AUTH_A', '+923002220001', now(), '{\"display_name\":\"Recovery Farmer A\"}'::jsonb),
  ('$AUTH_B', '+923002220002', now(), '{\"display_name\":\"Recovery Farmer B\"}'::jsonb)
on conflict (id) do nothing;" >/dev/null

PARTY_A="$(psql_db postgres "select id from public.parties where auth_user_id = '$AUTH_A'")"
PARTY_B="$(psql_db postgres "select id from public.parties where auth_user_id = '$AUTH_B'")"
if [ -z "$PARTY_A" ] || [ -z "$PARTY_B" ]; then echo "auth trigger did not provision parties"; exit 1; fi

# The real authenticated seam, not a hand-written crop row: it exercises the
# farmer profile, crop instance, stage history and recommendation refresh that
# a restore has to carry.
psql_as postgres authenticated "$AUTH_A" \
  "select public.prepare_my_recommendations('[{\"crop_code\":\"cotton\",\"stage\":\"sown\",\"primary\":true}]'::jsonb)" >/dev/null
psql_as postgres authenticated "$AUTH_B" \
  "select public.prepare_my_recommendations('[{\"crop_code\":\"wheat\",\"stage\":\"sown\",\"primary\":true}]'::jsonb)" >/dev/null

psql_root -v ON_ERROR_STOP=1 -c "
insert into public.climate_forecasts
  (provider_code, district_code, forecast_on, issued_on, tmax_c, tmin_c, precip_mm, humidity_pct, wind_kph, raw)
values
  ('open_meteo','layyah', current_date + 1, current_date, 34.2, 21.1, 0, 38, 12, '{}'::jsonb),
  ('open_meteo','layyah', current_date + 2, current_date, 35.0, 22.0, 0, 40, 14, '{}'::jsonb)
on conflict do nothing;

insert into public.weather_readings
  (provider_code, lat_cell, lon_cell, observed_at, temp_c, humidity_pct, wind_kph, kind, raw)
values ('weatherapi', 30.969, 70.943, now(), 31.5, 44, 11, 'current', '{}'::jsonb);" >/dev/null

EVENT_A="$(psql_as postgres authenticated "$AUTH_A" \
  "select r->>'event_id' from public.ai_claim_request('ask', 'recovery-a1') r" | tr -d '\n')"
psql_as postgres authenticated "$AUTH_A" \
  "select public.ai_finish_request('$EVENT_A', 'ok', 'gemini', 'gemini-2.0-flash', 900, 2, 1, null)" >/dev/null

SOURCE="$(snapshot postgres)"
echo "source snapshot: $SOURCE"
if [ -z "$SOURCE" ] || [ "${SOURCE#*|}" = "$SOURCE" ]; then echo "source snapshot failed"; exit 1; fi

echo
# The application backup is `public` plus the platform-owned identity rows. The
# real Supabase backup separates auth from application data the same way; the
# cluster-global extensions and storage internals are recreated by the platform,
# not carried in the dump. Including them made a restore into any database other
# than `postgres` fail on pg_cron, which is a property of the cluster, not of the
# application.
init_target() { # database
  docker exec -i "$CONTAINER" psql -U supabase_admin -d "$1" -X -q -v ON_ERROR_STOP=1 <<'SQL'
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists postgis with schema extensions;
create extension if not exists vector with schema extensions;
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid;
$$;
grant execute on function auth.uid() to anon, authenticated;
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key, name text not null, public boolean not null default false, file_size_limit bigint
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid,
  created_at timestamptz not null default now()
);
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)];
$$;
grant usage on schema public, auth, storage to anon, authenticated;
grant usage on schema extensions to anon, authenticated, public;
SQL
}

echo
echo "=========== 5. dump, restore into a separate database ==========="
docker exec "$CONTAINER" pg_dump -U supabase_admin -d postgres -n public -Fc -f /tmp/farmer-app.dump
echo "app dump exit=$?"
docker exec "$CONTAINER" pg_dump -U supabase_admin -d postgres -t auth.users --data-only -Fc -f /tmp/farmer-auth.dump
echo "auth dump exit=$?"
# GoTrue owns this table and its full column set. A schema-only dump restores the
# platform's real shape instead of a hand-written approximation that would drop
# columns the auth service expects. The trigger is created after the public
# function it calls; dumping it here would fail the split restore order.
docker exec "$CONTAINER" sh -c "pg_dump -U supabase_admin -d postgres -t auth.users --schema-only --no-owner -f /tmp/farmer-auth-raw.sql && sed '/CREATE TRIGGER on_auth_user_created/,/;/d' /tmp/farmer-auth-raw.sql > /tmp/farmer-auth-schema.sql"
echo "auth schema dump exit=$?"
docker exec "$CONTAINER" ls -l /tmp/farmer-app.dump | awk '{print "app dump bytes:", $5}'

docker exec "$CONTAINER" createdb -U supabase_admin restored
init_target restored
docker exec "$CONTAINER" psql -U supabase_admin -d restored -X -q -v ON_ERROR_STOP=1 -f /tmp/farmer-auth-schema.sql >/dev/null
docker exec "$CONTAINER" pg_restore -U supabase_admin -d restored --exit-on-error /tmp/farmer-auth.dump
echo "auth restore exit=$?"
docker exec "$CONTAINER" pg_restore -U supabase_admin -d restored --clean --if-exists --exit-on-error /tmp/farmer-app.dump
echo "app restore exit=$?"
docker exec "$CONTAINER" psql -U supabase_admin -d restored -X -q -v ON_ERROR_STOP=1 -c "
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.on_auth_user_created();"
echo "auth trigger restore exit=$?"

RESTORED="$(snapshot restored)"
expect_eq "restored snapshot matches the source" "$RESTORED" "$SOURCE"

echo
echo "-- schema, security and integrity details on the restored copy --"
expect_eq "public tables" "$(psql_db restored "select count(*) from pg_tables where schemaname='public'")" "90"
expect_eq "tables with RLS" "$(psql_db restored "select count(*) from pg_tables t where t.schemaname='public' and exists (select 1 from pg_class c where c.relname=t.tablename and c.relrowsecurity)")" "90"
expect_eq "unvalidated foreign keys" "$(psql_db restored "select count(*) from pg_constraint where contype='f' and not convalidated")" "0"
expect_eq "orphaned forecast districts" "$(psql_db restored "select count(*) from public.climate_forecasts f left join public.districts d on d.code=f.district_code where d.code is null")" "0"
expect_eq "knowledge citation sources resolve" "$(psql_db restored "select count(*) from public.agri_knowledge_entries e left join public.agri_knowledge_sources s on s.code=e.source_code where e.source_code is not null and s.code is null")" "0"
expect_eq "both farmers and their crops survived" "$(psql_db restored "select count(distinct p.id) || '/' || count(distinct c.id) from public.parties p left join public.crop_instances c on c.farmer_id=p.id where p.id in ('$PARTY_A','$PARTY_B')")" "2/2"
expect_eq "the AI event survived with its outcome" "$(psql_db restored "select outcome || '/' || provider from public.ai_request_events where client_request_id='recovery-a1'")" "ok/gemini"

echo
echo "-- and it still behaves like the platform, not just looks like it --"
case_out "a guest cannot read the AI event table" refuse restored anon "" "select count(*) from public.ai_request_events"
case_out "a farmer cannot read the AI event table directly" refuse restored authenticated "$AUTH_A" "select count(*) from public.ai_request_events"
expect_eq "A can claim a new AI request after restore" \
  "$(psql_as restored authenticated "$AUTH_A" "select (r->>'allowed') from public.ai_claim_request('ask','recovery-a2') r" | tr -d '\n')" "true"
expect_eq "B cannot finish A's restored event" \
  "$(psql_as restored authenticated "$AUTH_B" "select (public.ai_finish_request('$EVENT_A','ok',null,null,1,0,0,null))::text" | tr -d '\n')" "false"
expect_eq "retrieval still returns the cotton knowledge" \
  "$(psql_db restored "select count(*) > 0 from public.ai_knowledge_search('cotton pink bollworm', 'cotton', null, 3)")" "t"
expect_eq "the personalized feed still executes for A" \
  "$(psql_as restored authenticated "$AUTH_A" "select count(*) >= 0 from public.intelligence_recommendation_feed(10)" | tr -d '\n')" "t"
expect_eq "A's context still names the restored crop" \
  "$(psql_as restored authenticated "$AUTH_A" "select position('cotton' in public.farmer_intelligence_context()::text) > 0" | tr -d '\n')" "t"

# The auth trigger is part of the recovery surface: a restore that loses it would
# silently stop provisioning new accounts.
docker exec "$CONTAINER" psql -U supabase_admin -d restored -X -q -v ON_ERROR_STOP=1 -c "
insert into auth.users (id, phone, phone_confirmed_at, raw_user_meta_data)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '+923002220003', now(), '{\"display_name\":\"Recovered New Farmer\"}'::jsonb);" >/dev/null
expect_eq "a new auth user still provisions a party after restore" \
  "$(psql_db restored "select count(*) from public.parties where auth_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'")" "1"

echo
echo "=========== 6. failure scenarios are detected, not assumed ==========="
docker exec "$CONTAINER" createdb -U supabase_admin partial
init_target partial
docker exec "$CONTAINER" psql -U supabase_admin -d partial -X -q -v ON_ERROR_STOP=1 -f /tmp/farmer-auth-schema.sql >/dev/null
docker exec "$CONTAINER" pg_restore -U supabase_admin -d partial --section=pre-data /tmp/farmer-app.dump >/dev/null 2>&1
echo "partial restore exit=$? (pre-data only)"
PARTIAL="$(snapshot partial)"
checks=$((checks + 1))
if [ "$PARTIAL" != "$SOURCE" ] && [ -n "$PARTIAL" ]; then
  printf '  %-18s %-58s %s\n' "[OK]" "a schema-only restore is detected as incomplete" "$PARTIAL"
else
  printf '  %-18s %-58s\n' "[WRONG]" "a schema-only restore was mistaken for a complete restore"
  failures=$((failures + 1))
fi

docker exec "$CONTAINER" createdb -U supabase_admin interrupted
init_target interrupted
docker exec "$CONTAINER" psql -U supabase_admin -d interrupted -X -q -v ON_ERROR_STOP=1 -f /tmp/farmer-auth-schema.sql >/dev/null
docker exec "$CONTAINER" psql -U supabase_admin -d interrupted -X -q -v ON_ERROR_STOP=1 < /dev/null >/dev/null
# Kill a real restore rather than simulating one. If this tiny dataset ever
# restores inside the window, the case reports that instead of pretending.
docker exec "$CONTAINER" timeout 0.4 pg_restore -U supabase_admin -d interrupted --clean --if-exists /tmp/farmer-app.dump >/dev/null 2>&1
echo "interrupted restore exit=$? (124 means killed)"
INTERRUPTED="$(snapshot interrupted)"
checks=$((checks + 1))
if [ "$INTERRUPTED" != "$SOURCE" ]; then
  printf '  %-18s %-58s %s\n' "[OK]" "a killed restore is detected as incomplete" "${INTERRUPTED:-<no schema>}"
else
  printf '  %-18s %-58s\n' "[WRONG]" "a killed restore was mistaken for a complete restore"
  failures=$((failures + 1))
fi

# Restore is not resumable. The documented recovery is drop/recreate then restore
# from the dump, which is what this proves.
docker exec "$CONTAINER" dropdb -U supabase_admin interrupted
docker exec "$CONTAINER" createdb -U supabase_admin interrupted
init_target interrupted
docker exec "$CONTAINER" psql -U supabase_admin -d interrupted -X -q -v ON_ERROR_STOP=1 -f /tmp/farmer-auth-schema.sql >/dev/null
docker exec "$CONTAINER" pg_restore -U supabase_admin -d interrupted --exit-on-error /tmp/farmer-auth.dump
docker exec "$CONTAINER" pg_restore -U supabase_admin -d interrupted --clean --if-exists --exit-on-error /tmp/farmer-app.dump
echo "recovery re-restore exit=$?"
expect_eq "a clean re-restore recovers the killed target" "$(snapshot interrupted)" "$SOURCE"

# Restoring over a populated database must not silently merge or overwrite it.
docker exec "$CONTAINER" pg_restore -U supabase_admin -d restored /tmp/farmer-app.dump >/dev/null 2>&1
overwrite=$?
checks=$((checks + 1))
if [ "$overwrite" -ne 0 ]; then
  printf '  %-18s %-58s\n' "[OK]" "restore over a live copy is refused without a clean target"
else
  printf '  %-18s %-58s\n' "[WRONG]" "restore over a live copy silently succeeded"
  failures=$((failures + 1))
fi

echo
if [ "$failures" -eq 0 ]; then
  echo "recovery: every one of $checks cases behaved as the rules say it must"
else
  echo "recovery: $failures of $checks case(s) did NOT behave as the rules say"
fi
exit "$failures"
