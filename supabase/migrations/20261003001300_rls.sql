-- Farmer App · migration 0013 · row level security
--
-- PRD: critical rules must not exist only in the mobile UI. They are enforced
-- through RLS, backend authorization, RPCs and constraints. The client may
-- display rules but must not be the only layer enforcing them.
--
-- The migrations so far put the *business* rules in constraints and guarded
-- functions. This one puts the *authorization* rules in policies, so the API
-- itself refuses to hand one farmer another farmer's credit file.
--
-- Reading posture:
--   * anon (a guest) may read the public catalogues, community feed, market
--     rates and weather. That is the PRD's "guests can browse".
--   * a farmer may read and write their own domain rows.
--   * a dealer may read what concerns them, and write only what the workflows
--     function permits.
--   * moderators and admins act through capability, never through a role flag.

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere, so a table added later cannot be forgotten silently
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  for t in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and not c.relrowsecurity
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end;
$$;

-- Belt and braces: also revoke the blanket grants Supabase gives new tables, so
-- an unprotected table fails closed instead of leaking.
do $$
declare
  t text;
begin
  for t in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Public reference data: readable by guests
-- ---------------------------------------------------------------------------

create policy crop_catalog_read on public.crop_catalog for select to anon, authenticated using (is_active);
create policy areas_read on public.areas for select to anon, authenticated using (is_active);
create policy community_boards_read on public.community_boards for select to anon, authenticated using (is_active);
create policy market_commodities_read on public.market_commodities for select to anon, authenticated using (is_active);
create policy market_sources_read on public.market_sources for select to anon, authenticated using (is_active);
create policy agriculture_knowledge_read on public.agri_knowledge_entries for select to anon, authenticated using (is_published);

-- Market and weather are public information and are read by guests.
create policy market_observations_read on public.market_observations for select to anon, authenticated using (true);
create policy weather_readings_read on public.weather_readings for select to anon, authenticated using (true);
create policy weather_providers_read on public.weather_providers for select to anon, authenticated using (is_active);

-- A dealer's public storefront: enough to choose one, no business internals.
create policy dealer_profiles_read on public.dealer_profiles for select to anon, authenticated using (true);
create policy dealer_products_read on public.dealer_products for select to anon, authenticated using (true);
create policy canonical_products_read on public.canonical_products for select to anon, authenticated using (true);

-- Writes to the projection belong to the sync process, which runs as the
-- service role. No client role may insert, update or delete these.
revoke insert, update, delete on public.dealer_profiles from authenticated;
revoke insert, update, delete on public.dealer_products from authenticated;
revoke insert, update, delete on public.market_observations from authenticated;
revoke insert, update, delete on public.weather_readings from authenticated;
revoke insert, update, delete on public.canonical_products from authenticated;
revoke insert, update, delete on public.market_commodities from authenticated;
revoke insert, update, delete on public.areas from authenticated;
revoke insert, update, delete on public.crop_catalog from authenticated;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

-- A party sees itself and its own contacts. There is deliberately no policy
-- letting a farmer read a dealer's contacts or vice versa: the only relationship
-- between the two identity species is dealer_farmer_links, established by an
-- explicit act.
create policy parties_self_read on public.parties
  for select to authenticated
  using (auth_user_id = auth.uid() or public.has_capability('admin'));

create policy parties_self_update on public.parties
  for update to authenticated
  using (auth_user_id = auth.uid() or public.has_capability('admin'))
  with check (auth_user_id = auth.uid() or public.has_capability('admin'));

create policy party_contacts_self on public.party_contacts
  for all to authenticated
  using (party_id = public.current_party_id() or public.has_capability('admin'))
  with check (party_id = public.current_party_id() or public.has_capability('admin'));

-- A farmer reads only their own profile.
create policy farmer_profiles_own on public.farmer_profiles
  for all to authenticated
  using (party_id = public.current_farmer_id() or public.has_capability('admin'))
  with check (party_id = public.current_farmer_id() or public.has_capability('admin'));

create policy farmer_search_settings_own on public.farmer_search_settings
  for all to authenticated
  using (farmer_id = public.current_farmer_id() or public.has_capability('admin'))
  with check (farmer_id = public.current_farmer_id() or public.has_capability('admin'));

-- Temporary search areas belong to the farmer who made them.
create policy farmer_temporary_areas_own on public.farmer_temporary_areas
  for all to authenticated
  using (farmer_id = public.current_farmer_id() or public.has_capability('admin'))
  with check (farmer_id = public.current_farmer_id() or public.has_capability('admin'));

create policy delegate_links_party_read on public.dealer_farmer_links
  for select to authenticated
  using (
    farmer_id = public.current_farmer_id()
    or dealer_id in (select dp.id from public.dealer_profiles dp where dp.party_id = public.current_party_id())
    or public.has_capability('admin')
  );

-- Links are created by the visit and credit functions, not by clients.
revoke insert, update, delete on public.dealer_farmer_links from authenticated;

create policy party_capabilities_read_own on public.party_capabilities
  for select to authenticated
  using (party_id = public.current_party_id() or public.has_capability('admin'));

revoke insert, update, delete on public.party_capabilities from authenticated;

-- ---------------------------------------------------------------------------
-- Crops, facts and signals
-- ---------------------------------------------------------------------------

create policy crop_instances_own on public.crop_instances
  for all to authenticated
  using (farmer_id = public.current_farmer_id() or public.has_capability('admin'))
  with check (farmer_id = public.current_farmer_id() or public.has_capability('admin'));

create policy crop_facts_own on public.crop_facts
  for select to authenticated
  using (
    crop_id in (select ci.id from public.crop_instances ci where ci.farmer_id = public.current_farmer_id())
    or public.has_capability('admin')
  );

-- A farmer may state a fact, but may not rewrite history: superseding is done
-- by the confirm function, so direct updates and deletes are withheld.
revoke update, delete on public.crop_facts from authenticated;

create policy crop_facts_insert_own on public.crop_facts
  for insert to authenticated
  with check (
    crop_id in (select ci.id from public.crop_instances ci where ci.farmer_id = public.current_farmer_id())
    and source_kind in ('farmer_stated', 'imported')
  );

create policy crop_inferences_own on public.crop_inferences
  for select to authenticated
  using (
    crop_id in (select ci.id from public.crop_instances ci where ci.farmer_id = public.current_farmer_id())
    or public.has_capability('admin')
  );

-- Dismissal is a farmer act; promotion happens only through the RPC.
create policy crop_inferences_dismiss_own on public.crop_inferences
  for update to authenticated
  using (
    crop_id in (select ci.id from public.crop_instances ci where ci.farmer_id = public.current_farmer_id())
  )
  with check (
    crop_id in (select ci.id from public.crop_instances ci where ci.farmer_id = public.current_farmer_id())
  );

create policy crop_stage_history_own on public.crop_stage_history
  for select to authenticated
  using (
    crop_id in (select ci.id from public.crop_instances ci where ci.farmer_id = public.current_farmer_id())
    or public.has_capability('admin')
  );

revoke insert, update, delete on public.crop_stage_history from authenticated;

-- Behaviour signals are written by the app as the farmer uses it, and read only
-- by that farmer.
create policy behaviour_signals_own on public.behaviour_signals
  for all to authenticated
  using (farmer_id = public.current_farmer_id() or public.has_capability('admin'))
  with check (farmer_id = public.current_farmer_id());

-- ---------------------------------------------------------------------------
-- Recommendations and notifications
-- ---------------------------------------------------------------------------

create policy recommendations_own on public.recommendations
  for select to authenticated
  using (farmer_id = public.current_farmer_id() or public.has_capability('admin'));

-- Advice is produced by the server. A client cannot fabricate a recommendation.
revoke insert, update, delete on public.recommendations from authenticated;

create policy notification_events_own on public.notification_events
  for select to authenticated
  using (party_id = public.current_party_id() or public.has_capability('admin'));

-- Reading a notification is allowed, but the wording lives elsewhere, so no
-- update to content is possible.
create policy notification_events_mark_read on public.notification_events
  for update to authenticated
  using (party_id = public.current_party_id())
  with check (party_id = public.current_party_id());

revoke insert, delete on public.notification_events from authenticated;

-- ---------------------------------------------------------------------------
-- Field visits
-- ---------------------------------------------------------------------------

-- A farmer sees their own requests; a dealer sees the ones addressed to them.
create policy field_visits_own on public.field_visits
  for select to authenticated
  using (
    farmer_id = public.current_farmer_id()
    or dealer_id in (select dp.id from public.dealer_profiles dp where dp.party_id = public.current_party_id())
    or public.has_capability('admin')
  );

-- Creation goes through request_field_visit so the link row and the
-- one-open-request rule are applied together.
revoke insert on public.field_visits from authenticated;

-- Only the dealer responds, and only through the guarded path: the transition
-- trigger checks the actor, so an update policy that is broader than intended
-- still cannot make a farmer accept their own request.
create policy field_visits_dealer_respond on public.field_visits
  for update to authenticated
  using (
    dealer_id in (select dp.id from public.dealer_profiles dp where dp.party_id = public.current_party_id())
    or farmer_id = public.current_farmer_id()
    or public.has_capability('admin')
  )
  with check (
    dealer_id in (select dp.id from public.dealer_profiles dp where dp.party_id = public.current_party_id())
    or farmer_id = public.current_farmer_id()
    or public.has_capability('admin')
  );

revoke delete on public.field_visits from authenticated;

-- ---------------------------------------------------------------------------
-- Credit
-- ---------------------------------------------------------------------------

create policy credit_requests_party_read on public.credit_requests
  for select to authenticated
  using (
    farmer_id = public.current_farmer_id()
    or dealer_id in (select dp.id from public.dealer_profiles dp where dp.party_id = public.current_party_id())
    or public.has_capability('admin')
  );

-- Every credit write goes through a function that checks whose turn it is.
-- There is no direct insert, update or delete path for a client.
revoke insert, update, delete on public.credit_requests from authenticated;
revoke insert, update, delete on public.credit_request_versions from authenticated;
revoke insert, update, delete on public.credit_decisions from authenticated;

create policy credit_versions_party_read on public.credit_request_versions
  for select to authenticated
  using (
    request_id in (
      select r.id from public.credit_requests r
      where r.farmer_id = public.current_farmer_id()
         or r.dealer_id in (select dp.id from public.dealer_profiles dp where dp.party_id = public.current_party_id())
         or public.has_capability('admin')
    )
  );

create policy credit_decisions_party_read on public.credit_decisions
  for select to authenticated
  using (
    request_id in (
      select r.id from public.credit_requests r
      where r.farmer_id = public.current_farmer_id()
         or r.dealer_id in (select dp.id from public.dealer_profiles dp where dp.party_id = public.current_party_id())
         or public.has_capability('admin')
    )
  );

-- Consent is a farmer statement; the farmer may read it, and only the accept
-- function may write it.
create policy credit_consents_farmer_read on public.credit_consents
  for select to authenticated
  using (
    farmer_id = public.current_farmer_id()
    or request_id in (
      select r.id from public.credit_requests r
      where r.dealer_id in (select dp.id from public.dealer_profiles dp where dp.party_id = public.current_party_id())
    )
    or public.has_capability('admin')
  );

revoke insert, update, delete on public.credit_consents from authenticated;

create policy credit_agreements_party_read on public.credit_agreements
  for select to authenticated
  using (
    farmer_id = public.current_farmer_id()
    or dealer_id in (select dp.id from public.dealer_profiles dp where dp.party_id = public.current_party_id())
    or public.has_capability('admin')
  );

revoke insert, update, delete on public.credit_agreements from authenticated;

create policy credit_payments_party_read on public.credit_payments
  for select to authenticated
  using (
    agreement_id in (
      select a.id from public.credit_agreements a
      where a.farmer_id = public.current_farmer_id()
         or a.dealer_id in (select dp.id from public.dealer_profiles dp where dp.party_id = public.current_party_id())
         or public.has_capability('admin')
    )
  );

revoke insert, update, delete on public.credit_payments from authenticated;

-- ---------------------------------------------------------------------------
-- Community
-- ---------------------------------------------------------------------------

-- Guests read the feed. Hidden and deleted posts are excluded by the policy
-- rather than by every query remembering to filter.
create policy community_posts_read on public.community_posts
  for select to anon, authenticated
  using (deleted_at is null and hidden_at is null);

create policy community_replies_read on public.community_replies
  for select to anon, authenticated
  using (hidden_at is null);

-- A farmer may create a post only as themselves, and may edit only their own.
-- Soft deletion is done by the function, so delete is withheld here.
create policy community_posts_insert_own on public.community_posts
  for insert to authenticated
  with check (author_id = public.current_party_id());

create policy community_posts_update_own on public.community_posts
  for update to authenticated
  using (author_id = public.current_party_id() or public.has_capability('moderator') or public.has_capability('admin'))
  with check (author_id = public.current_party_id() or public.has_capability('moderator') or public.has_capability('admin'));

revoke delete on public.community_posts from authenticated;
revoke delete on public.community_replies from authenticated;

create policy community_replies_insert_own on public.community_replies
  for insert to authenticated
  with check (author_id = public.current_party_id());

create policy community_replies_update_own on public.community_replies
  for update to authenticated
  using (author_id = public.current_party_id() or public.has_capability('moderator') or public.has_capability('admin'))
  with check (author_id = public.current_party_id() or public.has_capability('moderator') or public.has_capability('admin'));

create policy community_reactions_own on public.community_reactions
  for all to authenticated
  using (party_id = public.current_party_id())
  with check (party_id = public.current_party_id());

-- Blocks are private to the blocker.
create policy community_blocks_own on public.community_blocks
  for all to authenticated
  using (blocker_id = public.current_party_id())
  with check (blocker_id = public.current_party_id());

-- Stories are visible while they are live.
create policy community_stories_read on public.community_stories
  for select to anon, authenticated
  using (expires_at > now());

create policy community_stories_insert_own on public.community_stories
  for insert to authenticated
  with check (author_id = public.current_party_id());

create policy community_stories_update_own on public.community_stories
  for update to authenticated
  using (author_id = public.current_party_id() or public.has_capability('moderator') or public.has_capability('admin'))
  with check (author_id = public.current_party_id() or public.has_capability('moderator') or public.has_capability('admin'));

create policy community_story_views_own on public.community_story_views
  for all to authenticated
  using (viewer_id = public.current_party_id())
  with check (viewer_id = public.current_party_id());

-- ---------------------------------------------------------------------------
-- Moderation
-- ---------------------------------------------------------------------------

-- A reporting farmer sees their own reports. The queue belongs to moderators.
create policy community_reports_own_read on public.community_reports
  for select to authenticated
  using (reporter_id = public.current_party_id() or public.has_capability('moderator') or public.has_capability('admin'));

revoke insert, update, delete on public.community_reports from authenticated;

create policy moderation_cases_staff on public.moderation_cases
  for select to authenticated
  using (public.has_capability('moderator') or public.has_capability('admin'));

revoke insert, update, delete on public.moderation_cases from authenticated;

create policy moderation_actions_staff on public.moderation_actions
  for select to authenticated
  using (public.has_capability('moderator') or public.has_capability('admin'));

revoke insert, update, delete on public.moderation_actions from authenticated;

-- ---------------------------------------------------------------------------
-- Expert verification
-- ---------------------------------------------------------------------------

-- An applicant reads their own application; reviewers read all of them.
create policy expert_applications_own_or_staff on public.expert_applications
  for select to authenticated
  using (
    applicant_id = public.current_party_id()
    or public.has_capability('moderator')
    or public.has_capability('admin')
  );

create policy expert_applications_insert_own on public.expert_applications
  for insert to authenticated
  with check (applicant_id = public.current_party_id());

-- Status changes are made by grant/suspend functions, not by the applicant.
revoke update, delete on public.expert_applications from authenticated;

create policy expert_qualifications_own_or_staff on public.expert_qualifications
  for select to authenticated
  using (
    application_id in (select a.id from public.expert_applications a where a.applicant_id = public.current_party_id())
    or public.has_capability('moderator')
    or public.has_capability('admin')
  );

create policy expert_qualifications_insert_own on public.expert_qualifications
  for insert to authenticated
  with check (
    application_id in (select a.id from public.expert_applications a where a.applicant_id = public.current_party_id())
  );

-- Marking a qualification verified is an admin act only.
revoke update, delete on public.expert_qualifications from authenticated;

-- The badge itself is public: farmers need to see who is verified.
create policy expert_verifications_read on public.expert_verifications
  for select to anon, authenticated
  using (true);

revoke insert, update, delete on public.expert_verifications from authenticated;

create policy expert_verification_history_staff on public.expert_verification_history
  for select to authenticated
  using (
    party_id = public.current_party_id()
    or public.has_capability('moderator')
    or public.has_capability('admin')
  );

revoke insert, update, delete on public.expert_verification_history from authenticated;

-- ---------------------------------------------------------------------------
-- Media and audit
-- ---------------------------------------------------------------------------

create policy media_assets_own on public.media_assets
  for select to authenticated
  using (owner_id = public.current_party_id() or public.has_capability('admin'));

-- Uploads are registered by validate_media_upload, which checks type and size.
create policy media_assets_insert_own on public.media_assets
  for insert to authenticated
  with check (owner_id = public.current_party_id());

revoke delete on public.media_assets from authenticated;

-- The audit log is append-only and readable only by staff. Writing happens
-- through write_audit, which is security definer.
create policy audit_log_staff_read on public.audit_log
  for select to authenticated
  using (public.has_capability('admin') or public.has_capability('moderator'));

revoke insert, update, delete on public.audit_log from authenticated;

create policy retention_policies_read on public.retention_policies
  for select to authenticated
  using (true);

revoke insert, update, delete on public.retention_policies from authenticated;

-- ---------------------------------------------------------------------------
-- Expose the workflow functions, and only those
-- ---------------------------------------------------------------------------

grant execute on function public.request_field_visit(uuid, uuid, text, uuid, date, text, text, text) to authenticated;
grant execute on function public.credit_submit_request(uuid, uuid, text, text, numeric, numeric, date, integer, text, text) to authenticated;
grant execute on function public.credit_begin_review(uuid) to authenticated;
grant execute on function public.credit_owner_accept(uuid) to authenticated;
grant execute on function public.credit_owner_counteroffer(uuid, numeric, numeric, date, integer, text) to authenticated;
grant execute on function public.credit_farmer_accept(uuid, uuid, jsonb) to authenticated;
grant execute on function public.credit_farmer_reject(uuid, text) to authenticated;
grant execute on function public.credit_farmer_withdraw(uuid, text) to authenticated;
grant execute on function public.credit_owner_final_decision(uuid, boolean, text) to authenticated;
grant execute on function public.credit_record_payment(uuid, numeric, date, text, text, text) to authenticated;
grant execute on function public.community_report_content(uuid, public.moderation_target, uuid, text, text) to authenticated;
grant execute on function public.moderate_apply(uuid, public.moderation_outcome, text, uuid, timestamptz) to authenticated;
grant execute on function public.verify_qualification(uuid, text) to authenticated;
grant execute on function public.grant_expert_verification(uuid, timestamptz, text) to authenticated;
grant execute on function public.set_expert_verification_status(uuid, public.verification_status, text) to authenticated;
grant execute on function public.confirm_inference_as_fact(uuid, text) to authenticated;
grant execute on function public.correct_crop_stage(uuid, public.crop_stage, text) to authenticated;
grant execute on function public.validate_media_upload(uuid, public.media_class, text, text, text, bigint) to authenticated;
grant execute on function public.community_create_post(uuid, text, text, text, text, text, text, text) to authenticated;
grant execute on function public.community_create_reply(uuid, uuid, text, uuid, text) to authenticated;
grant execute on function public.community_delete_own_post(uuid, uuid) to authenticated;
grant execute on function public.credit_outstanding(uuid) to authenticated;
grant execute on function public.farmer_credit_overview(uuid) to authenticated;
grant execute on function public.dealers_within_radius(uuid, double precision, double precision, integer) to authenticated;

-- Guest-readable read models.
grant execute on function public.community_feed(uuid, text, integer, timestamptz) to anon, authenticated;
grant execute on function public.market_rates(text, integer) to anon, authenticated;
grant execute on function public.latest_weather(double precision, double precision) to anon, authenticated;
grant execute on function public.weather_is_usable(double precision, double precision) to anon, authenticated;
grant execute on function public.farmer_insight_feed(uuid, integer) to authenticated;
