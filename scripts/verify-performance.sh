#!/usr/bin/env bash
#
# Phase 8 · bounded performance and concurrency evidence.
#
# This is not a production benchmark. It is a repeatable measurement of the
# database paths the app actually calls, on a disposable Supabase Postgres with
# the real schema and a small representative dataset. It answers four questions:
#
#   1. how long does each critical RPC take at p50/p95/p99;
#   2. does the shared rate limiter hold under concurrent claims;
#   3. how much throughput do the lifecycle, retrieval and feed paths sustain;
#   4. does the database recover after a restart, and how long does it take.
#
# Thresholds are deliberate budgets, not fitted to the result. They are generous
# for a single-region database and are printed with every measurement so a
# regression is visible even while the absolute numbers stay small.
#
# Only a local Docker container is used. No paid provider, staging or production
# endpoint is called. `--keep` leaves the container for inspection.
#
#   npm run db:bundle && bash scripts/verify-performance.sh

set -u
export MSYS_NO_PATHCONV=1

CONTAINER=farmer-app-performance
IMAGE=public.ecr.aws/supabase/postgres:17.6.1.159
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

AUTH_A=aaaaaaaa-aaaa-4aaa-8aaa-000000000001
PERF_TMP=".perf-tmp"

failures=0
checks=0

cleanup() {
  rm -rf "$PERF_TMP"
  if [ "$KEEP" -eq 0 ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1
  else
    echo
    echo "kept: docker exec -it $CONTAINER psql -U supabase_admin -d postgres"
  fi
}
trap cleanup EXIT

psql_db() { docker exec "$CONTAINER" psql -U supabase_admin -d postgres -X -A -t -c "$1" 2>/dev/null | tr -d '\r'; }
psql_rows() { docker exec "$CONTAINER" psql -U supabase_admin -d postgres -X -A -t -F '|' -c "$1" 2>/dev/null | tr -d '\r'; }
psql_root() { docker exec -i "$CONTAINER" psql -U supabase_admin -d postgres -X -q "$@"; }
psql_write() { docker exec -i "$CONTAINER" psql -U supabase_admin -d postgres -X -q -v ON_ERROR_STOP=1 "$@" >/dev/null; }

expect_eq() { # label, actual, expected
  local label="$1" actual="$2" expected="$3"
  checks=$((checks + 1))
  if [ "$actual" = "$expected" ]; then
    printf '  %-14s %-56s %s\n' "[OK]" "$label" "$actual"
  else
    printf '  %-14s %-56s got '\''%s'\'', expected '\''%s'\''\n' "[WRONG]" "$label" "$actual" "$expected"
    failures=$((failures + 1))
  fi
}

expect_p95() { # label, actual, budget
  local label="$1" actual="$2" budget="$3"
  checks=$((checks + 1))
  if [ -n "$actual" ] && awk -v v="$actual" -v b="$budget" 'BEGIN { exit !(v <= b) }'; then
    printf '  %-14s %-56s p95 %sms (budget %sms)\n' "[OK]" "$label" "$actual" "$budget"
  else
    printf '  %-14s %-56s p95 %sms exceeds budget %sms\n' "[WRONG]" "$label" "${actual:-<none>}" "$budget"
    failures=$((failures + 1))
  fi
}

echo "=========== 1. a clean disposable Supabase Postgres ==========="
rm -rf "$PERF_TMP"
mkdir -p "$PERF_TMP"
docker rm -f "$CONTAINER" >/dev/null 2>&1
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null || {
  echo "could not start $IMAGE — is Docker running?"; exit 1
}

ready=0
for _ in $(seq 1 150); do
  if [ "$(docker logs "$CONTAINER" 2>&1 | grep -c 'database system is ready to accept connections')" -ge 2 ] \
     && [ "$(psql_db 'select 1')" = "1" ]; then
    sleep 3
    if [ "$(psql_db 'select 1')" = "1" ]; then ready=1; break; fi
  fi
  sleep 1
done
if [ "$ready" -eq 1 ]; then echo "ready"; else
  echo "the database never came up:"; docker logs --tail 20 "$CONTAINER"; exit 1
fi

echo
echo "=========== 2. platform shim and the real bundled schema ==========="
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
if ! grep -q '20261105000200_ai_gateway_controls.sql' "$ROOT/supabase/apply-all.sql"; then
  echo "apply-all.sql is stale — run: npm run db:bundle"; exit 1
fi
psql_root -v ON_ERROR_STOP=1 < "$ROOT/supabase/apply-all.sql" > /tmp/farmer-performance-apply.log 2>&1
bundle=$?
echo "bundle exit=$bundle (0 expected)"
if [ "$bundle" -ne 0 ]; then tail -12 /tmp/farmer-performance-apply.log; exit 1; fi

echo
echo "=========== 3. forty farmers and the rows the paths read ==========="
psql_root -v ON_ERROR_STOP=1 <<SQL
insert into auth.users (id, phone, phone_confirmed_at, raw_user_meta_data)
select
  ('aaaaaaaa-aaaa-4aaa-8aaa-' || lpad(i::text, 12, '0'))::uuid,
  '+92300333' || lpad(i::text, 4, '0'),
  now(),
  jsonb_build_object('display_name', 'Perf Farmer ' || i)
from generate_series(1, 40) i;

create schema if not exists perf;
create table perf.parties (
  idx integer primary key,
  auth_user_id uuid not null,
  party_id uuid not null
);
insert into perf.parties (idx, auth_user_id, party_id)
select row_number() over (order by u.id)::integer, u.id, p.id
from auth.users u
join public.parties p on p.auth_user_id = u.id
where u.id::text like 'aaaaaaaa-aaaa-4aaa-8aaa-%';

create table perf.samples (
  label text not null,
  ms double precision not null,
  ran_at timestamptz not null default now()
);
grant usage on schema perf to authenticated, service_role;
grant select on perf.parties to authenticated, service_role;
grant select, insert on perf.samples to authenticated, service_role;

-- Two farmers are enough for the feed/context paths; the other 38 exist so the
-- AI lifecycle can rotate parties and stay below the shared 20/minute limit.
do \$\$
declare
  p record;
begin
  for p in select auth_user_id, party_id from perf.parties where idx <= 2 loop
    perform set_config('request.jwt.claims', json_build_object('sub', p.auth_user_id)::text, true);
    perform public.sync_my_crops('[{"crop_code":"cotton","stage":"sown","primary":true}]'::jsonb);
    perform public.refresh_farmer_recommendations(p.party_id);
  end loop;
end \$\$;

insert into public.climate_forecasts
  (provider_code, district_code, forecast_on, issued_on, tmax_c, tmin_c, precip_mm, humidity_pct, wind_kph, raw)
values
  ('open_meteo','layyah', current_date + 1, current_date, 34.2, 21.1, 0, 38, 12, '{}'::jsonb),
  ('open_meteo','layyah', current_date + 2, current_date, 35.0, 22.0, 0, 40, 14, '{}'::jsonb);

insert into public.weather_readings
  (provider_code, lat_cell, lon_cell, observed_at, temp_c, humidity_pct, wind_kph, kind, raw)
values ('weatherapi', 30.969, 70.943, now(), 31.5, 44, 11, 'current', '{}'::jsonb);

insert into public.weather_ingestion_runs (provider_code, status, lease_expires_at)
values ('weatherapi', 'running', now() - interval '1 minute');
SQL

RUN_ID="$(psql_db "select id from public.weather_ingestion_runs order by id limit 1")"
FARMER_A="$(psql_db "select party_id from perf.parties where idx = 1")"
echo "farmers=$(psql_db "select count(*) from perf.parties") run=$RUN_ID farmer_a=$FARMER_A"

echo
echo "=========== 4. per-call latency, measured inside PostgreSQL ==========="
# A DO block times each call with clock_timestamp(); this excludes psql process
# startup and connection setup, which would otherwise dominate the result.
psql_root -v ON_ERROR_STOP=1 <<SQL
set role authenticated;
set request.jwt.claims = '{"sub":"$AUTH_A"}';

do \$\$
declare
  p record;
  j jsonb;
  t timestamptz;
  i integer;
begin
  for i in 1..200 loop
    select * into p from perf.parties where idx = ((i - 1) % 40) + 1;
    perform set_config('request.jwt.claims', json_build_object('sub', p.auth_user_id)::text, true);
    t := clock_timestamp();
    j := public.ai_claim_request('ask', 'perf-' || p.idx || '-' || i);
    perform public.ai_finish_request((j->>'event_id')::uuid, 'ok', 'gemini', 'gemini-2.0-flash', 40, 1, 1, null);
    insert into perf.samples (label, ms) values ('ai_lifecycle', extract(epoch from clock_timestamp() - t) * 1000);
  end loop;
end \$\$;

do \$\$
declare
  p record;
  t timestamptz;
  i integer;
begin
  for i in 1..200 loop
    select * into p from perf.parties where idx = 1;
    perform set_config('request.jwt.claims', json_build_object('sub', p.auth_user_id)::text, true);
    t := clock_timestamp();
    perform count(*) from public.intelligence_recommendation_feed(20);
    insert into perf.samples (label, ms) values ('recommendation_feed', extract(epoch from clock_timestamp() - t) * 1000);
    t := clock_timestamp();
    perform public.farmer_intelligence_context();
    insert into perf.samples (label, ms) values ('farmer_context', extract(epoch from clock_timestamp() - t) * 1000);
    t := clock_timestamp();
    perform count(*) from public.climate_forecasts where district_code = 'layyah' and forecast_on >= current_date;
    insert into perf.samples (label, ms) values ('forecast_read', extract(epoch from clock_timestamp() - t) * 1000);
  end loop;
end \$\$;

do \$\$
declare
  t timestamptz;
  i integer;
begin
  for i in 1..200 loop
    t := clock_timestamp();
    perform count(*) from public.crop_instances;
    insert into perf.samples (label, ms) values ('rls_authenticated', extract(epoch from clock_timestamp() - t) * 1000);
  end loop;
end \$\$;
SQL

psql_root -v ON_ERROR_STOP=1 <<SQL
set role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', false);
do \$\$
declare
  t timestamptz;
  i integer;
begin
  for i in 1..200 loop
    t := clock_timestamp();
    perform count(*) from public.ai_knowledge_search('cotton pink bollworm', 'cotton', null, 5);
    insert into perf.samples (label, ms) values ('knowledge_retrieval', extract(epoch from clock_timestamp() - t) * 1000);
    t := clock_timestamp();
    perform count(*) from public.crop_instances;
    insert into perf.samples (label, ms) values ('rls_service', extract(epoch from clock_timestamp() - t) * 1000);
    t := clock_timestamp();
    perform public.touch_ingestion_run('weather', $RUN_ID);
    insert into perf.samples (label, ms) values ('ingestion_lease', extract(epoch from clock_timestamp() - t) * 1000);
    t := clock_timestamp();
    perform count(*) from public.recover_abandoned_ingestion_runs(10);
    insert into perf.samples (label, ms) values ('ingestion_recover', extract(epoch from clock_timestamp() - t) * 1000);
  end loop;
end \$\$;
SQL

echo "-- p50 / p95 / p99 (ms), 200 samples per path --"
while IFS='|' read -r label count p50 p95 p99; do
  printf '  %-24s n=%-4s p50=%-7s p95=%-7s p99=%s\n' "$label" "$count" "$p50" "$p95" "$p99"
done < <(psql_rows "
  select label, count(*),
         round(percentile_cont(0.50) within group (order by ms)::numeric, 2),
         round(percentile_cont(0.95) within group (order by ms)::numeric, 2),
         round(percentile_cont(0.99) within group (order by ms)::numeric, 2)
    from perf.samples group by label order by label")

p95_of() { psql_db "select round(percentile_cont(0.95) within group (order by ms)::numeric, 2) from perf.samples where label = '$1'"; }
expect_p95 "AI lifecycle" "$(p95_of ai_lifecycle)" 120
expect_p95 "knowledge retrieval" "$(p95_of knowledge_retrieval)" 200
expect_p95 "recommendation feed" "$(p95_of recommendation_feed)" 250
expect_p95 "farmer context" "$(p95_of farmer_context)" 100
expect_p95 "forecast read" "$(p95_of forecast_read)" 50
expect_p95 "ingestion lease" "$(p95_of ingestion_lease)" 50
expect_p95 "ingestion recovery" "$(p95_of ingestion_recover)" 100
expect_p95 "RLS-authenticated read" "$(p95_of rls_authenticated)" 50
expect_p95 "service-role read" "$(p95_of rls_service)" 50

RLS_AUTH="$(p95_of rls_authenticated)"
RLS_SERVICE="$(p95_of rls_service)"
checks=$((checks + 1))
if awk -v a="$RLS_AUTH" -v b="$RLS_SERVICE" 'BEGIN { exit !(a <= b + 30) }'; then
  printf '  %-14s %-56s auth %sms vs service %sms\n' "[OK]" "RLS overhead stays within 30ms" "$RLS_AUTH" "$RLS_SERVICE"
else
  printf '  %-14s %-56s auth %sms vs service %sms\n' "[WRONG]" "RLS overhead exceeds 30ms" "$RLS_AUTH" "$RLS_SERVICE"
  failures=$((failures + 1))
fi

echo
echo "=========== 5. concurrency: the shared minute limit must hold ==========="
cat > "$PERF_TMP/perf-claim.sql" <<'SQL'
\set rid random(1, 1000000000)
SELECT set_config('request.jwt.claims', json_build_object('sub', (SELECT auth_user_id FROM perf.parties WHERE idx = 40))::text, false);
SELECT (public.ai_claim_request('ask', 'race-' || pg_backend_pid() || '-' || :rid)->>'allowed')::boolean;
SQL
# Drop any prior row for party 40 so the burst starts from zero.
psql_write -c "delete from public.ai_request_events where party_id = (select party_id from perf.parties where idx = 40);"
psql_write -c "delete from public.ai_rate_windows where party_id = (select party_id from perf.parties where idx = 40);"
docker cp "$PERF_TMP/perf-claim.sql" "$CONTAINER:/tmp/perf-claim.sql" >/dev/null
docker exec "$CONTAINER" pgbench -U supabase_admin -d postgres -n -c 20 -j 4 -t 2 -f /tmp/perf-claim.sql > /tmp/farmer-perf-race.log 2>&1
race=$?
echo "pgbench race exit=$race"
expect_eq "concurrent claims allowed exactly twenty" \
  "$(psql_db "select count(*) from public.ai_request_events e join perf.parties p on p.party_id=e.party_id where p.idx=40 and e.outcome='started'")" "20"
expect_eq "the other twenty are rate-limited" \
  "$(psql_db "select count(*) from public.ai_request_events e join perf.parties p on p.party_id=e.party_id where p.idx=40 and e.outcome='rate_limited'")" "20"

echo
echo "=========== 6. throughput under concurrent clients ==========="
cat > "$PERF_TMP/perf-lifecycle.sql" <<'SQL'
\set pidx random(1, 40)
\set rid random(1, 1000000000)
SELECT set_config('request.jwt.claims', json_build_object('sub', (SELECT auth_user_id FROM perf.parties WHERE idx = :pidx))::text, false);
WITH r AS (
  SELECT public.ai_claim_request('ask', 'bench-' || pg_backend_pid() || '-' || :rid) j
)
SELECT public.ai_finish_request((j->>'event_id')::uuid, 'ok', 'gemini', 'gemini-2.0-flash', 40, 1, 1, null) FROM r;
SQL
cat > "$PERF_TMP/perf-retrieval.sql" <<'SQL'
SELECT count(*) FROM public.ai_knowledge_search('cotton pink bollworm', 'cotton', null, 5);
SQL
cat > "$PERF_TMP/perf-feed.sql" <<'SQL'
SELECT set_config('request.jwt.claims', json_build_object('sub', (SELECT auth_user_id FROM perf.parties WHERE idx = 1))::text, false);
SELECT count(*) FROM public.intelligence_recommendation_feed(20);
SQL
docker cp "$PERF_TMP/perf-lifecycle.sql" "$CONTAINER:/tmp/perf-lifecycle.sql" >/dev/null
docker cp "$PERF_TMP/perf-retrieval.sql" "$CONTAINER:/tmp/perf-retrieval.sql" >/dev/null
docker cp "$PERF_TMP/perf-feed.sql" "$CONTAINER:/tmp/perf-feed.sql" >/dev/null

run_pgbench() { # label, clients, transactions, script, minimum tps
  local label="$1" clients="$2" txs="$3" script="$4" minimum="$5"
  docker exec "$CONTAINER" pgbench -U supabase_admin -d postgres -n \
    -c "$clients" -j 4 -t "$txs" -f "$script" > "/tmp/farmer-perf-$label.log" 2>&1
  local code=$? tps failed
  tps="$(grep -oE 'tps = [0-9.]+' "/tmp/farmer-perf-$label.log" | head -1 | awk '{print $3}')"
  failed="$(grep -oE 'number of failed transactions: [0-9]+' "/tmp/farmer-perf-$label.log" | awk '{print $NF}')"
  printf '  %-18s tps=%s failed=%s exit=%s\n' "$label" "${tps:-?}" "${failed:-?}" "$code"
  expect_eq "$label: no failed transactions" "${failed:-1}" "0"
  checks=$((checks + 1))
  if [ -n "$tps" ] && awk -v v="$tps" -v m="$minimum" 'BEGIN { exit !(v >= m) }'; then
    printf '  %-18s %-48s %s tps (floor %s)\n' "[OK]" "$label throughput" "$tps" "$minimum"
  else
    printf '  %-18s %-48s %s tps (floor %s)\n' "[WRONG]" "$label throughput" "${tps:-<none>}" "$minimum"
    failures=$((failures + 1))
  fi
}

run_pgbench lifecycle 20 10 /tmp/perf-lifecycle.sql 10
run_pgbench retrieval 20 50 /tmp/perf-retrieval.sql 20
run_pgbench feed 10 20 /tmp/perf-feed.sql 5

echo
echo "=========== 7. restart recovery ==========="
start=$(date +%s)
docker restart "$CONTAINER" >/dev/null
recovered=0
for _ in $(seq 1 60); do
  if [ "$(psql_db 'select 1')" = "1" ]; then recovered=1; break; fi
  sleep 1
done
elapsed=$(( $(date +%s) - start ))
expect_eq "the database answers after a restart" "$recovered" "1"
checks=$((checks + 1))
if [ "$elapsed" -le 60 ]; then
  printf '  %-14s %-56s %ss (budget 60s)\n' "[OK]" "restart recovery time" "$elapsed"
else
  printf '  %-14s %-56s %ss exceeds budget 60s\n' "[WRONG]" "restart recovery time" "$elapsed"
  failures=$((failures + 1))
fi
sleep 2
after_restart="$(psql_root -A -t <<SQL
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '$AUTH_A')::text, false);
select (r->>'allowed') from public.ai_claim_request('ask', 'after-restart') r;
SQL
)"
expect_eq "a claim still succeeds after restart" \
  "$(printf '%s' "$after_restart" | tail -1 | tr -d '[:space:]')" "true"

echo
if [ "$failures" -eq 0 ]; then
  echo "performance: every one of $checks cases behaved as the rules say it must"
else
  echo "performance: $failures of $checks case(s) did NOT behave as the rules say"
fi
exit "$failures"
