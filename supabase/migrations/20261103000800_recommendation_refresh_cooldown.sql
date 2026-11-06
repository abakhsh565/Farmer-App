-- Phase 4 fix · recommendation refresh cooldown
--
-- Migration 007 captured the previous primary crop after the synchronization
-- loop had already cleared every is_primary flag. The result was NULL, so each
-- prepare call looked like a crop change, invalidated the cooldown and reran the
-- generator. This replacement captures the prior primary before updating crops;
-- a no-op sync now leaves recommendations_refreshed_at intact.

create or replace function public.sync_my_crops(p_crops jsonb default '[]'::jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_farmer         uuid := public.current_farmer_id();
  v_item           jsonb;
  v_code           text;
  v_stage_text     text;
  v_stage          public.crop_stage;
  v_primary        boolean;
  v_primary_code   text;
  v_current_primary text;
  v_id             uuid;
  v_row            public.crop_instances;
  v_codes          text[] := '{}'::text[];
  v_changed        boolean := false;
  v_count          integer := 0;
begin
  if v_farmer is null then
    raise exception 'An identified farmer is required.' using errcode = 'insufficient_privilege';
  end if;

  if p_crops is null or jsonb_typeof(p_crops) <> 'array' then
    raise exception 'Crop context must be a JSON array.' using errcode = 'check_violation';
  end if;

  if jsonb_array_length(p_crops) > 12 then
    raise exception 'At most 12 active crops may be synchronized.' using errcode = 'check_violation';
  end if;

  -- Stage corrections are validated by the existing trigger. The sync path gives
  -- it an explicit reason, so a correction is traceable to the app's update.
  perform set_config('app.stage_correction_reason', 'active crop list synchronized from the app', true);

  -- Capture this before the loop clears primary flags while updating rows. Reading
  -- it afterwards would always produce NULL and falsely invalidate the cache.
  select crop_code into v_current_primary
    from public.crop_instances
   where farmer_id = v_farmer
     and closed_at is null
     and is_primary
   limit 1;

  for v_item in select value from jsonb_array_elements(p_crops) loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'Each crop must be an object.' using errcode = 'check_violation';
    end if;

    v_code := nullif(btrim(v_item->>'crop_code'), '');
    if v_code is null or v_code !~ '^[a-z][a-z0-9_]{1,40}$'
       or not exists (select 1 from public.crop_catalog c where c.code = v_code and c.is_active) then
      raise exception 'Unknown crop code: %', coalesce(v_code, '(null)') using errcode = 'check_violation';
    end if;

    if v_code = any (v_codes) then
      raise exception 'Crop % appears more than once in the context.', v_code using errcode = 'check_violation';
    end if;
    v_codes := array_append(v_codes, v_code);

    v_stage_text := coalesce(nullif(btrim(v_item->>'stage'), ''), 'planned');
    if v_stage_text not in
       ('planned','sown','germinating','vegetative','flowering','fruiting','maturity','harvested','failed') then
      raise exception 'Unknown crop stage: %', v_stage_text using errcode = 'check_violation';
    end if;
    v_stage := v_stage_text::public.crop_stage;

    v_primary := case
      when jsonb_typeof(v_item->'primary') = 'boolean' then (v_item->>'primary')::boolean
      else false
    end;
    if v_primary then
      if v_primary_code is not null then
        raise exception 'Only one crop may be primary.' using errcode = 'check_violation';
      end if;
      v_primary_code := v_code;
    end if;

    select * into v_row
      from public.crop_instances
     where farmer_id = v_farmer
       and crop_code = v_code
       and closed_at is null
     order by created_at, id
     limit 1;

    if found then
      if v_row.stage is distinct from v_stage or not v_row.app_synced then
        v_changed := true;
      end if;
      update public.crop_instances
         set stage = v_stage,
             app_synced = true,
             is_primary = false
       where id = v_row.id;
    else
      insert into public.crop_instances (farmer_id, crop_code, stage, is_primary, app_synced)
      values (v_farmer, v_code, v_stage, false, true)
      returning * into v_row;
      v_changed := true;
    end if;

    v_count := v_count + 1;
  end loop;

  -- Close only app-owned crops that disappeared from the local list. A crop
  -- entered by an agronomist/import is never closed by this path.
  if exists (
    select 1 from public.crop_instances c
     where c.farmer_id = v_farmer
       and c.app_synced
       and c.closed_at is null
       and not (c.crop_code = any (v_codes))
  ) then
    v_changed := true;
    update public.crop_instances
       set closed_at = now(), is_primary = false
     where farmer_id = v_farmer
       and app_synced
       and closed_at is null
       and not (crop_code = any (v_codes));
  end if;

  if v_primary_code is null and array_length(v_codes, 1) is not null then
    v_primary_code := v_codes[1];
  end if;

  if v_current_primary is distinct from v_primary_code then
    v_changed := true;
  end if;

  if array_length(v_codes, 1) is not null then
    update public.crop_instances
       set is_primary = false
     where farmer_id = v_farmer
       and closed_at is null
       and is_primary;

    update public.crop_instances
       set is_primary = true
     where farmer_id = v_farmer
       and crop_code = v_primary_code
       and closed_at is null;
  end if;

  insert into public.farmer_intelligence_profiles (
    farmer_id, primary_crop_code, recommendations_refreshed_at
  ) values (
    v_farmer, v_primary_code, null
  )
  on conflict (farmer_id) do update
    set primary_crop_code = excluded.primary_crop_code,
        recommendations_refreshed_at = case
          when v_changed then null
          else public.farmer_intelligence_profiles.recommendations_refreshed_at
        end,
        updated_at = now();

  return v_count;
end;
$$;

comment on function public.sync_my_crops(jsonb) is
  'Validated, JWT-owned synchronization of the app crop list into the canonical crop table. Closes only app-owned stale rows and invalidates recommendations only on a real change.';
