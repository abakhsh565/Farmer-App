-- Farmer App · migration 0008 · community
--
-- The community feature is the one place a farmer publishes. The PRD wants:
-- guests may read, identity is required to write, a report is a report and not
-- a deletion, and content the author deletes leaves the answers written to it.
--
-- That last rule is unusual and easy to get wrong, so it is a schema decision
-- here: replies do not cascade from posts. Deleting a post is a soft delete
-- that hides the body while the thread survives.

create table public.community_boards (
  code        text primary key,
  name_en     text not null,
  name_ur     text not null,
  names_local jsonb not null default '{}'::jsonb,
  description text,
  sort_order  integer not null default 0,
  is_active   boolean not null default true
);

insert into public.community_boards (code, name_en, name_ur, sort_order) values
  ('general',   'General',    'عمومی',      10),
  ('crops',     'Crops',      'فصلیں',      20),
  ('pests',     'Pests',      'کیڑے',       30),
  ('weather',   'Weather',    'موسم',       40),
  ('market',    'Market',     'منڈی',       50),
  ('machinery', 'Machinery',  'مشینری',     60);

-- ---------------------------------------------------------------------------
-- Posts
-- ---------------------------------------------------------------------------

create table public.community_posts (
  id             uuid primary key default gen_random_uuid(),
  board_code     text not null references public.community_boards (code),
  author_id      uuid references public.parties (id) on delete set null,
  -- Kept even if the author later deletes their account, so the thread remains
  -- readable without exposing an identity that no longer exists.
  author_name    text not null default 'Farmer',
  title          text,
  body           text not null check (length(btrim(body)) between 1 and 8000),
  crop_code      text references public.crop_catalog (code),
  area_label     text,
  language       text not null default 'ur',
  -- Soft delete. The row stays so replies keep their parent.
  deleted_at     timestamptz,
  deleted_by     uuid references public.parties (id),
  -- Moderation outcome, distinct from the author's own deletion.
  hidden_at      timestamptz,
  hidden_by      uuid references public.parties (id),
  hidden_reason  text,
  reply_count    integer not null default 0,
  reaction_count integer not null default 0,
  idempotency_key text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create trigger community_posts_touch before update on public.community_posts
  for each row execute function public.touch_updated_at();

create index community_posts_feed_idx on public.community_posts (board_code, created_at desc)
  where deleted_at is null and hidden_at is null;

create unique index community_posts_idempotency_idx
  on public.community_posts (author_id, idempotency_key)
  where idempotency_key is not null;

comment on table public.community_posts is
  'Author deletion is soft. `deleted_at` hides the body; the row survives so the answers written to it remain reachable, which is what the PRD asks for.';

-- ---------------------------------------------------------------------------
-- Replies
-- ---------------------------------------------------------------------------

-- Note the absence of ON DELETE CASCADE from post_id. Replies outlive the post
-- body, and the database will not let a post deletion take them with it.
create table public.community_replies (
  id             uuid primary key default gen_random_uuid(),
  post_id        uuid not null references public.community_posts (id) on delete restrict,
  parent_id      uuid references public.community_replies (id) on delete restrict,
  author_id      uuid references public.parties (id) on delete set null,
  author_name    text not null default 'Farmer',
  body           text not null check (length(btrim(body)) between 1 and 4000),
  deleted_at     timestamptz,
  deleted_by     uuid references public.parties (id),
  hidden_at      timestamptz,
  hidden_by      uuid references public.parties (id),
  hidden_reason  text,
  reaction_count integer not null default 0,
  idempotency_key text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create trigger community_replies_touch before update on public.community_replies
  for each row execute function public.touch_updated_at();

create index community_replies_thread_idx on public.community_replies (post_id, created_at);

create unique index community_replies_idempotency_idx
  on public.community_replies (author_id, idempotency_key)
  where idempotency_key is not null;

comment on column public.community_replies.post_id is
  'ON DELETE RESTRICT, not CASCADE. A post cannot be hard-deleted out from under its answers, so the PRD rule that a deleted post leaves its replies intact is enforced by the foreign key.';

-- Keep the denormalised counters honest from the database side.
create or replace function public.sync_post_reply_count()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_post uuid;
begin
  -- TG_OP branching rather than coalesce(new.x, old.x): in a DELETE trigger the
  -- NEW record is unassigned and merely reading a field from it raises.
  if tg_op = 'DELETE' then
    v_post := old.post_id;
  else
    v_post := new.post_id;
  end if;

  update public.community_posts p
     set reply_count = (
       select count(*) from public.community_replies r
        where r.post_id = v_post and r.deleted_at is null and r.hidden_at is null
     )
   where p.id = v_post;

  return null;
end;
$$;

-- Separate triggers because "update of <columns>" cannot be combined with
-- "or delete" in a single trigger definition.
create trigger community_replies_sync_count_write
  after insert or update of deleted_at, hidden_at on public.community_replies
  for each row execute function public.sync_post_reply_count();

create trigger community_replies_sync_count_delete
  after delete on public.community_replies
  for each row execute function public.sync_post_reply_count();

-- ---------------------------------------------------------------------------
-- Reactions
-- ---------------------------------------------------------------------------

create table public.community_reactions (
  id          bigserial primary key,
  party_id    uuid not null references public.parties (id) on delete cascade,
  post_id     uuid references public.community_posts (id) on delete cascade,
  reply_id    uuid references public.community_replies (id) on delete cascade,
  kind        text not null default 'helpful' check (kind in ('helpful', 'thanks', 'agree')),
  created_at  timestamptz not null default now(),
  constraint community_reactions_one_target check (
    (post_id is not null)::int + (reply_id is not null)::int = 1
  )
);

create unique index community_reactions_post_idx
  on public.community_reactions (party_id, post_id, kind) where post_id is not null;
create unique index community_reactions_reply_idx
  on public.community_reactions (party_id, reply_id, kind) where reply_id is not null;

-- ---------------------------------------------------------------------------
-- Stories
-- ---------------------------------------------------------------------------

create table public.community_stories (
  id             uuid primary key default gen_random_uuid(),
  author_id      uuid not null references public.parties (id) on delete cascade,
  author_name    text not null default 'Farmer',
  caption        text,
  media_id       uuid,
  crop_code      text references public.crop_catalog (code),
  area_label     text,
  -- Stories expire by design, not by a cleanup job guessing.
  expires_at     timestamptz not null default now() + interval '24 hours',
  created_at     timestamptz not null default now(),
  constraint community_stories_expiry check (expires_at > created_at)
);

create index community_stories_live_idx on public.community_stories (expires_at desc);

create table public.community_story_views (
  story_id    uuid not null references public.community_stories (id) on delete cascade,
  viewer_id   uuid not null references public.parties (id) on delete cascade,
  viewed_at   timestamptz not null default now(),
  primary key (story_id, viewer_id)
);

-- ---------------------------------------------------------------------------
-- Blocks
-- ---------------------------------------------------------------------------

-- A block hides one author's content from another farmer. It is a reading
-- preference and never a moderation outcome.
create table public.community_blocks (
  blocker_id  uuid not null references public.parties (id) on delete cascade,
  blocked_id  uuid not null references public.parties (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint community_blocks_not_self check (blocker_id <> blocked_id)
);

-- ---------------------------------------------------------------------------
-- Reading and writing
-- ---------------------------------------------------------------------------

-- One feed function for every client, filtered by blocks. A guest (no party)
-- gets the same feed with is_mine false everywhere, which is how "guests may
-- read" stays true without a second code path.
create or replace function public.community_feed(
  p_farmer_id uuid default null,
  p_board     text default null,
  p_limit     integer default 30,
  p_before    timestamptz default null
)
returns table (
  post_id      uuid,
  board_code   text,
  author_name  text,
  title        text,
  body         text,
  crop_code    text,
  area_label   text,
  reply_count  integer,
  reaction_count integer,
  is_mine      boolean,
  created_at   timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    p.id,
    p.board_code,
    p.author_name,
    p.title,
    p.body,
    p.crop_code,
    p.area_label,
    p.reply_count,
    p.reaction_count,
    (p_farmer_id is not null and p.author_id = p_farmer_id),
    p.created_at
  from public.community_posts p
  where p.deleted_at is null
    and p.hidden_at is null
    and (p_board is null or p.board_code = p_board)
    and (p_before is null or p.created_at < p_before)
    and not exists (
      select 1 from public.community_blocks b
       where p_farmer_id is not null
         and b.blocker_id = p_farmer_id
         and b.blocked_id = p.author_id
    )
  order by p.created_at desc
  limit greatest(1, least(p_limit, 100));
$$;

comment on function public.community_feed(uuid, text, integer, timestamptz) is
  'Public reading path. A NULL farmer id is a guest: same rows, minus the viewer-specific bits — not a separate query with its own bugs.';

-- Posting requires identity. This is enforced by the function refusing a NULL
-- author, and by the RLS policy in migration 0013 which requires auth.uid().
create or replace function public.community_create_post(
  p_author_id     uuid,
  p_board_code    text,
  p_title         text,
  p_body          text,
  p_crop_code     text default null,
  p_area_label    text default null,
  p_language      text default 'ur',
  p_idempotency_key text default null
)
returns public.community_posts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_post public.community_posts;
  v_name text;
begin
  if p_author_id is null then
    raise exception 'Posting requires an identified farmer.' using errcode = 'insufficient_privilege';
  end if;

  select display_name into v_name from public.parties where id = p_author_id;

  insert into public.community_posts (
    board_code, author_id, author_name, title, body, crop_code, area_label, language, idempotency_key
  ) values (
    p_board_code, p_author_id, coalesce(v_name, 'Farmer'), p_title, p_body, p_crop_code, p_area_label, p_language, p_idempotency_key
  )
  returning * into v_post;

  return v_post;
exception
  when unique_violation then
    -- Offline queue replaying the same post.
    select * into v_post
      from public.community_posts
     where author_id = p_author_id and idempotency_key = p_idempotency_key;
    if found then
      return v_post;
    end if;
    raise;
end;
$$;

create or replace function public.community_create_reply(
  p_author_id     uuid,
  p_post_id       uuid,
  p_body          text,
  p_parent_id     uuid default null,
  p_idempotency_key text default null
)
returns public.community_replies
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reply public.community_replies;
  v_name  text;
  v_post  public.community_posts;
begin
  if p_author_id is null then
    raise exception 'Replying requires an identified farmer.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_post from public.community_posts where id = p_post_id;
  if not found then
    raise exception 'Post % not found.', p_post_id using errcode = 'no_data_found';
  end if;

  -- The thread stays open even when the body is gone: that is the point of a
  -- soft delete. What is closed is a moderated post.
  if v_post.hidden_at is not null then
    raise exception 'This post has been hidden and is closed to replies.' using errcode = 'check_violation';
  end if;

  select display_name into v_name from public.parties where id = p_author_id;

  insert into public.community_replies (post_id, parent_id, author_id, author_name, body, idempotency_key)
  values (p_post_id, p_parent_id, p_author_id, coalesce(v_name, 'Farmer'), p_body, p_idempotency_key)
  returning * into v_reply;

  return v_reply;
exception
  when unique_violation then
    select * into v_reply
      from public.community_replies
     where author_id = p_author_id and idempotency_key = p_idempotency_key;
    if found then
      return v_reply;
    end if;
    raise;
end;
$$;

-- Author deletion: soft, and permitted only on your own content.
create or replace function public.community_delete_own_post(p_post_id uuid, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_post public.community_posts;
begin
  select * into v_post from public.community_posts where id = p_post_id for update;
  if not found then
    raise exception 'Post % not found.', p_post_id using errcode = 'no_data_found';
  end if;

  if v_post.author_id is distinct from p_actor then
    raise exception 'You can only delete your own post.' using errcode = 'insufficient_privilege';
  end if;

  -- Body hidden, replies untouched. This is the PRD rule, in one statement.
  update public.community_posts
     set deleted_at = now(), deleted_by = p_actor, body = '', title = null
   where id = p_post_id;
end;
$$;
