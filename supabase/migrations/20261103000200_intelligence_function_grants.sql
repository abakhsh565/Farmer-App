-- Farmer App · migration 0037 · intelligence function execution grants
--
-- Found by executing the Phase 1 verification against the Farmer project:
-- PostgreSQL grants EXECUTE to PUBLIC by default, so revoking from
-- `authenticated` alone left every new RPC callable by `anon`. Each function
-- already raises when current_farmer_id() is null, so no row leaked — but a
-- runtime guard is not an authorisation boundary, and "fails safely" is not the
-- same as "not callable". This migration makes the grant match the policy.
--
-- refresh_farmer_interests and job_refresh_farmer_intelligence are already
-- revoked from PUBLIC in migration 0036; they are repeated here so the boundary
-- is stated in one place and survives a future CREATE OR REPLACE.

revoke execute on function public.record_behaviour_event(
  text, text, text, text, uuid, text, public.signal_strength, numeric, jsonb, timestamptz, text
) from public, anon;

revoke execute on function public.upsert_farmer_interest(text, numeric, text, boolean)
  from public, anon;

revoke execute on function public.record_intelligence_feedback(text, text, uuid, text, text, jsonb)
  from public, anon;

revoke execute on function public.farmer_intelligence_context(uuid) from public, anon;

revoke execute on function public.intelligence_recommendation_feed(integer) from public, anon;

revoke execute on function public.refresh_farmer_interests(integer) from public, anon;

revoke execute on function public.job_refresh_farmer_intelligence(integer) from public, anon;

grant execute on function public.record_behaviour_event(
  text, text, text, text, uuid, text, public.signal_strength, numeric, jsonb, timestamptz, text
) to authenticated;

grant execute on function public.upsert_farmer_interest(text, numeric, text, boolean)
  to authenticated;

grant execute on function public.record_intelligence_feedback(text, text, uuid, text, text, jsonb)
  to authenticated;

grant execute on function public.farmer_intelligence_context(uuid) to authenticated;

grant execute on function public.intelligence_recommendation_feed(integer) to authenticated;
