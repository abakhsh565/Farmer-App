#!/usr/bin/env bash
#
# Phase 5's server-side AI controls, proved against a real Supabase Postgres.
#
# The Edge Function is not the whole control surface. Rate limiting, duplicate
# protection, telemetry and feedback live in the database because isolates do
# not share memory, and the function is only as trustworthy as the RPCs it
# calls. Reading the SQL does not establish that:
#
#   · a body field cannot claim another party's identity;
#   · a replayed request id is recognised instead of charged twice;
#   · the 21st request in a minute is refused for that party and no other;
#   · one party cannot finish or give feedback on another party's answer;
#   · the tables themselves are unreachable by a client;
#   · telemetry persists route/outcome/provider/latency/counts and no question.
#
# What it does, from nothing:
#
#   1. starts a throwaway Supabase Postgres container — never a shared stack
#   2. creates the platform pieces Supabase provides and this repository does
#      not own: roles, `auth.uid()` and the storage schema the policies need
#   3. applies `supabase/apply-all.sql` in one transaction, as pasted
#   4. provisions three farmers through the auth trigger
#   5. plays the controls out case by case, printing [OK] or the reason a case
#      did not behave as the rules say it must
#
# `--keep` leaves the container running for inspection; by default it is removed.
# Requires Docker. Nothing here touches a hosted project, and no credential is
# read or printed.
#
#   npm run db:bundle && bash scripts/verify-ai-controls.sh

set -u

CONTAINER=farmer-app-ai-controls
IMAGE=public.ecr.aws/supabase/postgres:17.6.1.159
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

AUTH_A=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
AUTH_B=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb
AUTH_C=cccccccc-cccc-4ccc-8ccc-cccccccccccc
AUTH_NONE=dddddddd-dddd-4ddd-8ddd-dddddddddddd

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
  printf '  %-16s %-54s %s\n' "[$verdict]" "$label" "$(echo "$out" | tr '\n' ' ' | cut -c1-92)"
}

expect_eq() { # label, actual, expected
  local label="$1" actual="$2" expected="$3"
  checks=$((checks + 1))
  if [ "$actual" = "$expected" ]; then
    printf '  %-16s %-54s %s\n' "[OK]" "$label" "$actual"
  else
    printf '  %-16s %-54s got '\''%s'\'', expected '\''%s'\''\n' "[WRONG]" "$label" "$actual" "$expected"
    failures=$((failures + 1))
  fi
}

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
# it. A single successful query proves nothing; readiness is the second "ready to
# accept connections" in the log, and a query that still answers after it.
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
-- columns and confirmation timestamps are missing, and the chain reads them.
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

grant usage on schema public, auth, storage to anon, authenticated;
grant usage on schema extensions to anon, authenticated, public;

grant select on storage.buckets to anon, authenticated;
grant select, insert, update, delete on storage.objects to anon, authenticated;
alter table storage.objects enable row level security;
SQL
echo "shim exit=$? (0 expected)"

echo
echo "=========== 3. supabase/apply-all.sql, as the owner will paste it ==========="
if ! grep -q '20261105000200_ai_gateway_controls.sql' "$ROOT/supabase/apply-all.sql"; then
  echo "apply-all.sql does not contain the AI controls migration — run: npm run db:bundle"
  exit 1
fi
psql_root -v ON_ERROR_STOP=1 < "$ROOT/supabase/apply-all.sql" > /tmp/farmer-ai-controls-apply.log 2>&1
bundle=$?
echo "bundle exit=$bundle (0 expected)"
if [ "$bundle" -ne 0 ]; then tail -12 /tmp/farmer-ai-controls-apply.log; exit 1; fi
echo "tables=$(psql_value "select count(*) from pg_tables where schemaname = 'public'") \
with_rls=$(psql_value "select count(*) from pg_tables t where t.schemaname = 'public' and exists (select 1 from pg_class c where c.relname = t.tablename and c.relrowsecurity)") \
functions=$(psql_value "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'")"

echo
echo "=========== 4. three farmers, provisioned by the auth trigger ==========="
psql_root -v ON_ERROR_STOP=1 -c "
insert into auth.users (id, phone, phone_confirmed_at, raw_user_meta_data) values
  ('$AUTH_A', '+923001110001', now(), '{\"display_name\":\"AI Farmer A\"}'::jsonb),
  ('$AUTH_B', '+923001110002', now(), '{\"display_name\":\"AI Farmer B\"}'::jsonb),
  ('$AUTH_C', '+923001110003', now(), '{\"display_name\":\"AI Farmer C\"}'::jsonb)
on conflict (id) do nothing;" >/dev/null

PARTY_A="$(psql_value "select id from public.parties where auth_user_id = '$AUTH_A'")"
PARTY_B="$(psql_value "select id from public.parties where auth_user_id = '$AUTH_B'")"
PARTY_C="$(psql_value "select id from public.parties where auth_user_id = '$AUTH_C'")"
echo "parties: A=$PARTY_A B=$PARTY_B C=$PARTY_C"
if [ -z "$PARTY_A" ] || [ -z "$PARTY_B" ] || [ -z "$PARTY_C" ]; then
  echo "the auth trigger did not provision a party"; exit 1
fi

echo
echo "=========== 5. who may call the gate at all ==========="
case_out "a guest calls the gate" refuse anon "" "select public.ai_claim_request('ask', null)"
case_out "a token with no party calls it" refuse authenticated "$AUTH_NONE" "select public.ai_claim_request('ask', null)"
case_out "a claim with an unknown route" refuse authenticated "$AUTH_A" "select public.ai_claim_request('predict', 'bad-route')"
case_out "a request id over 80 characters" refuse authenticated "$AUTH_A" "select public.ai_claim_request('ask', repeat('x', 81))"

echo
echo "-- the first claim, and what a replay does --"
expect_as "A's first claim is allowed" authenticated "$AUTH_A" \
  "select (r->>'allowed') || '/' || (r->>'duplicate') from public.ai_claim_request('ask', 'req-a1') r" "true/false"
EVENT_A1="$(psql_value "select id from public.ai_request_events where client_request_id = 'req-a1'")"
expect_as "the same id is a duplicate, not a new charge" authenticated "$AUTH_A" \
  "select r->>'allowed' || '/' || (r->>'duplicate') || '/' || ((r->>'event_id') = '$EVENT_A1') from public.ai_claim_request('ask', 'req-a1') r" "false/true/true"
expect_eq "one event exists for the two submissions" \
  "$(psql_value "select count(*) from public.ai_request_events where client_request_id = 'req-a1'")" "1"
expect_eq "the duplicate did not increment the minute counter" \
  "$(psql_value "select request_count from public.ai_rate_windows w where w.party_id = '$PARTY_A' and w.window_kind = 'minute' and w.window_start = date_trunc('minute', (select created_at from public.ai_request_events where id = '$EVENT_A1'))")" "1"
expect_eq "the event starts as started, with no private text" \
  "$(psql_value "select outcome || '/' || coalesce(error_code, 'null') from public.ai_request_events where id = '$EVENT_A1'")" "started/null"

echo
echo "=========== 6. finishing: only the caller's own claim ==========="
expect_as "B cannot finish A's event" authenticated "$AUTH_B" \
  "select (public.ai_finish_request('$EVENT_A1', 'ok', 'gemini', 'gemini-2.0-flash', 1200, 3, 2, null))::text" "false"
expect_eq "A's event is untouched by B" \
  "$(psql_value "select outcome from public.ai_request_events where id = '$EVENT_A1'")" "started"
case_out "a made-up outcome is refused" refuse authenticated "$AUTH_A" \
  "select public.ai_finish_request('$EVENT_A1', 'hacked', null, null, 1, 0, 0, null)"
case_out "a made-up provider is refused" refuse authenticated "$AUTH_A" \
  "select public.ai_finish_request('$EVENT_A1', 'ok', 'anthropic', null, 1, 0, 0, null)"
case_out "a null event id is refused" refuse authenticated "$AUTH_A" \
  "select public.ai_finish_request(null::uuid, 'ok')"
expect_as "A finishes its own event" authenticated "$AUTH_A" \
  "select (public.ai_finish_request('$EVENT_A1', 'ok', 'gemini', 'gemini-2.0-flash', 999999, 99, 99, ''))::text" "true"
expect_eq "telemetry clamps latency and counts and persists" \
  "$(psql_value "select outcome || '/' || provider || '/' || model || '/' || latency_ms || '/' || evidence_count || '/' || citation_count || '/' || (finished_at is not null)::text from public.ai_request_events where id = '$EVENT_A1'")" \
  "ok/gemini/gemini-2.0-flash/300000/20/40/true"
expect_as "finishing the same event again is refused" authenticated "$AUTH_A" \
  "select (public.ai_finish_request('$EVENT_A1', 'ok', 'gemini', 'gemini-2.0-flash', 1000, 1, 1, null))::text" "false"
expect_eq "and the stored result did not change" \
  "$(psql_value "select outcome || '/' || evidence_count from public.ai_request_events where id = '$EVENT_A1'")" "ok/20"

echo
echo "=========== 7. feedback: bounded, own-answer only ==========="
psql_as authenticated "$AUTH_A" "select public.ai_claim_request('ask', 'req-a2')" >/dev/null
case_out "feedback before the answer is finished" refuse authenticated "$AUTH_A" \
  "select public.ai_feedback('req-a2', true, null)"
case_out "feedback for an id that never existed" refuse authenticated "$AUTH_A" \
  "select public.ai_feedback('req-nope', true, null)"
case_out "feedback with a reason outside the enum" refuse authenticated "$AUTH_A" \
  "select public.ai_feedback('req-a1', true, 'because')"
expect_as "A records feedback on its own answered request" authenticated "$AUTH_A" \
  "select public.ai_feedback('req-a1', true, 'unsafe')" "t"
expect_as "A changes its mind, replacing the same row" authenticated "$AUTH_A" \
  "select public.ai_feedback('req-a1', false, 'unclear')" "t"
expect_eq "one feedback row, holding the latest signal" \
  "$(psql_value "select count(*) || '/' || bool_and(helpful = false) || '/' || bool_and(reason = 'unclear') from public.ai_answer_feedback where party_id = '$PARTY_A'")" "1/true/true"
case_out "B gives feedback on A's request id" refuse authenticated "$AUTH_B" \
  "select public.ai_feedback('req-a1', true, null)"

echo
echo "=========== 8. the shared minute limit, and it is per party ==========="
expect_eq "20 of 21 claims allowed for C in one minute" \
  "$(psql_as authenticated "$AUTH_C" "select count(*) filter (where (r->>'allowed')::boolean) || '/' || count(*) filter (where (r->>'allowed')::boolean is false) from (select public.ai_claim_request('ask', 'rl-' || g) r from generate_series(1, 21) g) s" | tr -d '\n')" "20/1"
expect_eq "the refusal carries a bounded retry" \
  "$(psql_as authenticated "$AUTH_C" "select ((r->>'retry_after_seconds')::integer between 1 and 60) || '/' || (r->>'allowed') from public.ai_claim_request('ask', 'rl-extra') r" | tr -d '\n')" "true/false"
expect_eq "C's events record 20 started and 2 rate-limited" \
  "$(psql_value "select count(*) filter (where outcome = 'started') || '/' || count(*) filter (where outcome = 'rate_limited') from public.ai_request_events where party_id = '$PARTY_C'")" "20/2"
expect_eq "C's minute counter reached 22" \
  "$(psql_value "select request_count from public.ai_rate_windows where party_id = '$PARTY_C' and window_kind = 'minute' and window_start = date_trunc('minute', now())")" "22"
expect_as "A is not limited by C's spend" authenticated "$AUTH_A" \
  "select (r->>'allowed') || '/' || (r->>'duplicate') from public.ai_claim_request('ask', 'req-a3') r" "true/false"
expect_eq "the day counter is per party too" \
  "$(psql_value "select (select request_count from public.ai_rate_windows where party_id = '$PARTY_A' and window_kind = 'day' and window_start = date_trunc('day', now())) || '/' || (select request_count from public.ai_rate_windows where party_id = '$PARTY_C' and window_kind = 'day' and window_start = date_trunc('day', now()))")" "3/22"

echo
echo "=========== 9. the tables are not a client API ==========="
case_out "a farmer reads the event table" refuse authenticated "$AUTH_A" \
  "select count(*) from public.ai_request_events"
case_out "a farmer writes the event table" refuse authenticated "$AUTH_A" \
  "insert into public.ai_request_events (party_id, route) values ('$PARTY_A', 'ask')"
case_out "a farmer reopens the rate limit" refuse authenticated "$AUTH_A" \
  "update public.ai_rate_windows set request_count = 0"
case_out "a farmer reads another's feedback" refuse authenticated "$AUTH_B" \
  "select count(*) from public.ai_answer_feedback"
case_out "a guest reads the event table" refuse anon "" \
  "select count(*) from public.ai_request_events"

expect_eq "all three control tables have RLS on" \
  "$(psql_value "select count(*) from pg_tables where schemaname = 'public' and tablename in ('ai_request_events','ai_rate_windows','ai_answer_feedback') and rowsecurity")" "3"
expect_eq "authenticated may execute the three RPCs" \
  "$(psql_value "select bool_and(has_function_privilege('authenticated', p, 'execute'))::text from unnest(array['public.ai_claim_request(text,text)','public.ai_finish_request(uuid,text,text,text,integer,integer,integer,text)','public.ai_feedback(text,boolean,text)']) p")" "true"
expect_eq "anon may execute none of them" \
  "$(psql_value "select bool_or(has_function_privilege('anon', p, 'execute'))::text from unnest(array['public.ai_claim_request(text,text)','public.ai_finish_request(uuid,text,text,text,integer,integer,integer,text)','public.ai_feedback(text,boolean,text)']) p")" "false"

echo
echo "-- and nothing private could have been stored --"
expect_eq "no question, prompt, image, crop or citation-text column" \
  "$(psql_value "select count(*) from information_schema.columns where table_schema = 'public' and table_name in ('ai_request_events','ai_rate_windows','ai_answer_feedback') and column_name ~* '(question|prompt|image|crop|district|profile|body|message|content|transcript)'")" "0"
expect_eq "the solver event doc is the record an operator needs" \
  "$(psql_value "select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'ai_request_events' and column_name in ('route','outcome','provider','model','latency_ms','evidence_count','citation_count','error_code')")" \
  "route,outcome,provider,model,latency_ms,evidence_count,citation_count,error_code"

echo
if [ "$failures" -eq 0 ]; then
  echo "ai-controls: every one of $checks cases behaved as the rules say it must"
else
  echo "ai-controls: $failures of $checks case(s) did NOT behave as the rules say"
fi
exit "$failures"
