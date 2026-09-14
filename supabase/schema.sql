-- Meta Ads Library Saver: team spaces.
--
-- Run this once in your project's SQL editor. It is idempotent, so re-running
-- after an edit is safe.
--
-- Two decisions are load-bearing and worth reading before changing anything:
--
--   1. unique (team_id, archive_id) on ads. Two people saving the same ad is
--      the normal case, not a conflict, so every write is an upsert onto this
--      constraint. Without it the same creative arrives once per teammate.
--
--   2. deleted_at everywhere instead of DELETE. A device that was offline when
--      something was removed still holds it, and on its next push it would
--      helpfully put it back. Tombstones also give undo for free.
--
-- Everything is scoped by membership, never by ownership: a team's rows are
-- readable and writable by its members and by nobody else.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- profiles

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default 'Me',
  created_at   timestamptz not null default now()
);

-- ------------------------------------------------------------------- teams

create table if not exists public.teams (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  join_code  text not null unique,
  owner_id   uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.team_members (
  team_id   uuid not null references public.teams (id) on delete cascade,
  user_id   uuid not null references auth.users (id) on delete cascade,
  role      text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

create index if not exists team_members_user_idx on public.team_members (user_id);

-- ------------------------------------------------------------------- lists

create table if not exists public.lists (
  id         uuid primary key default gen_random_uuid(),
  team_id    uuid not null references public.teams (id) on delete cascade,
  name       text not null,
  colour     text not null default '#2a78d6',
  position   int  not null default 0,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists lists_team_idx on public.lists (team_id, deleted_at);

-- --------------------------------------------------------------------- ads

create table if not exists public.ads (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams (id) on delete cascade,
  archive_id  text not null,
  advertiser  text,
  page_id     text,
  started_at  timestamptz,
  ended_at    timestamptz,
  is_active   boolean,
  format      text,
  cta         text,
  link        text,
  body        text,
  -- Signed CDN links expire in hours, so these are a convenience for a
  -- download that happens soon after the save, not an archive.
  thumb_url   text,
  hd_url      text,
  raw         jsonb not null default '{}'::jsonb,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  unique (team_id, archive_id)
);

create index if not exists ads_team_idx on public.ads (team_id, deleted_at);
create index if not exists ads_updated_idx on public.ads (team_id, updated_at);

-- ---------------------------------------------------------------- list_ads

create table if not exists public.list_ads (
  list_id    uuid not null references public.lists (id) on delete cascade,
  ad_id      uuid not null references public.ads (id) on delete cascade,
  added_by   uuid references auth.users (id) on delete set null,
  added_at   timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (list_id, ad_id)
);

create index if not exists list_ads_ad_idx on public.list_ads (ad_id);

-- --------------------------------------------------------------- ad_scores
--
-- What the model thought of one ad, cached so nobody pays twice for it.
--
-- Keyed by (team_id, archive_id, rubric_version), not by ads.id, for the same
-- reason everything client-side is: archive_id is the only ad id the extension
-- holds, and (team_id, archive_id) is already unique on ads. There is
-- deliberately no foreign key to ads - a score should outlive the library
-- record being tidied away, and an offline teammate can score an ad before its
-- row has landed.
--
-- rubric_version is on the key, not beside it. The rubric is a prompt; editing
-- it changes the scale. Versioning it means an edit makes old scores visibly
-- non-comparable instead of quietly mixing two scales on one chart.
--
-- No overall column. The weighted mean is computed in the client so the weights
-- can be retuned without re-scoring anything.

create table if not exists public.ad_scores (
  team_id        uuid not null references public.teams (id) on delete cascade,
  archive_id     text not null,
  rubric_version text not null,
  model          text,
  axes           jsonb not null default '{}'::jsonb,
  frames         int,
  frame_kind     text,
  usage          jsonb,
  problems       jsonb,
  created_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (team_id, archive_id, rubric_version)
);

create index if not exists ad_scores_team_idx
  on public.ad_scores (team_id, updated_at);

-- ---------------------------------------------------------------- canvases
--
-- A canvas is a brief: reference ads as nodes, each with the free-text note
-- saying what to take from it, wired into an output node that generates a shot
-- list and a script. It lives in the team rather than on one device because the
-- notes are the work, and because the ads it points at are already team-scoped
-- by (team_id, archive_id).
--
-- Nodes are rows rather than one jsonb document on the canvas. A single column
-- is simpler and syncs atomically, and it also means "Ana wrote the hook note
-- while Ben wrote the lighting note" loses one of them to last-write-wins. Rows
-- make the conflict unit a node, which matters precisely because the per-node
-- text is the product.

create table if not exists public.canvases (
  id         uuid primary key default gen_random_uuid(),
  team_id    uuid not null references public.teams (id) on delete cascade,
  name       text not null default 'Untitled canvas',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists canvases_team_idx
  on public.canvases (team_id, deleted_at);
create index if not exists canvases_updated_idx
  on public.canvases (team_id, updated_at);

-- ------------------------------------------------------------ canvas_nodes
--
-- A node points at an ad by archive_id, and there is deliberately no foreign
-- key to ads. Three reasons, in order of weight:
--
--   1. archive_id is the only ad id the client holds. The local store keys ads
--      by it and so does list.adIds; the remote uuid is learned during a push
--      and never kept. (team_id, archive_id) is already unique on ads, so the
--      reference resolves without one.
--
--   2. A node has to survive its ad being deleted from the library. A foreign
--      key would forbid exactly the state this feature exists to tolerate.
--
--   3. An offline teammate can add a node before that ad's row has landed.
--
-- snapshot is what makes that survival graceful: the ad's text as it was when
-- it was dropped on the canvas. Text only, never media - CDN links are signed
-- and expire in hours, and the local thumbnail is a data URL that has never
-- travelled, so an image copied in here would be both large and dead within a
-- day.
--
-- note is the blank text field the whole feature is about. On a reference node
-- it is what to pull; on an output node it is the brief; on a note node it is
-- free context.

create table if not exists public.canvas_nodes (
  id         uuid primary key default gen_random_uuid(),
  canvas_id  uuid not null references public.canvases (id) on delete cascade,
  kind       text not null default 'reference'
               check (kind in ('reference', 'note', 'output')),
  archive_id text,
  note       text,
  snapshot   jsonb not null default '{}'::jsonb,
  x          real not null default 0,
  y          real not null default 0,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  -- A reference node with no ad points at nothing; a note or output node
  -- carrying one is a modelling mistake.
  check ((kind = 'reference') = (archive_id is not null))
);

create index if not exists canvas_nodes_canvas_idx
  on public.canvas_nodes (canvas_id, deleted_at);
create index if not exists canvas_nodes_archive_idx
  on public.canvas_nodes (archive_id);

-- ------------------------------------------------------------ canvas_edges

create table if not exists public.canvas_edges (
  canvas_id  uuid not null references public.canvases (id) on delete cascade,
  from_node  uuid not null references public.canvas_nodes (id) on delete cascade,
  to_node    uuid not null references public.canvas_nodes (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (from_node, to_node)
);

create index if not exists canvas_edges_canvas_idx
  on public.canvas_edges (canvas_id, deleted_at);

-- ------------------------------------------------------------- canvas_runs
--
-- The graph is the only mutable state; a run is what a generation produced,
-- appended and never edited. Runs exist because the output is not actually
-- regenerable: the model is nondeterministic, the referenced ad can be deleted,
-- and the frames a run would use come from signed URLs that expire in hours.
-- Re-running is a new draft, not a refresh, and re-running on render re-bills.
--
--   input_digest - a fingerprint of the ordered (archive_id, note) pairs plus
--     the output node's brief. When it stops matching the live graph the run is
--     a previous take, and the UI says so rather than silently answering a
--     question nobody is asking any more.
--
--   inputs - what the run actually saw, per node, including whether the ad was
--     still in the library. A run over a deleted reference still works from its
--     snapshot text; this is where that shows.

create table if not exists public.canvas_runs (
  id             uuid primary key default gen_random_uuid(),
  canvas_id      uuid not null references public.canvases (id) on delete cascade,
  team_id        uuid not null references public.teams (id) on delete cascade,
  output_node    uuid references public.canvas_nodes (id) on delete set null,
  status         text not null default 'done'
                   check (status in ('pending', 'running', 'done', 'error')),
  model          text,
  prompt_version text not null default 'canvas_v1',
  input_digest   text,
  inputs         jsonb not null default '[]'::jsonb,
  concept        text,
  shot_list      jsonb not null default '[]'::jsonb,
  script         jsonb not null default '[]'::jsonb,
  notes          text,
  error          text,
  created_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);

create index if not exists canvas_runs_canvas_idx
  on public.canvas_runs (canvas_id, created_at desc);
create index if not exists canvas_runs_team_idx
  on public.canvas_runs (team_id, updated_at);
create index if not exists canvas_runs_digest_idx
  on public.canvas_runs (canvas_id, input_digest);

-- ------------------------------------------------------------------ grants
--
-- RLS decides which rows a role may touch; it does not grant the role the
-- right to touch the table at all. Both are needed, and this half is easy to
-- forget because a superuser in the SQL editor never feels it: the first
-- signed-in user does, as "permission denied for table ads".
--
-- Only authenticated gets anything. anon is left with nothing, so an
-- unauthenticated caller holding the publishable key is refused at the
-- privilege check before RLS is even consulted.

grant usage on schema public to authenticated;

grant select, insert, update, delete on
  public.profiles, public.teams, public.team_members,
  public.lists, public.ads, public.list_ads, public.ad_scores,
  public.canvases, public.canvas_nodes, public.canvas_edges, public.canvas_runs
  to authenticated;

revoke all on
  public.profiles, public.teams, public.team_members,
  public.lists, public.ads, public.list_ads, public.ad_scores,
  public.canvases, public.canvas_nodes, public.canvas_edges, public.canvas_runs
  from anon;

-- ------------------------------------------------------------- row security

alter table public.profiles     enable row level security;
alter table public.teams        enable row level security;
alter table public.team_members enable row level security;
alter table public.lists        enable row level security;
alter table public.ads          enable row level security;
alter table public.list_ads     enable row level security;
alter table public.ad_scores    enable row level security;
alter table public.canvases     enable row level security;
alter table public.canvas_nodes enable row level security;
alter table public.canvas_edges enable row level security;
alter table public.canvas_runs  enable row level security;

-- Membership test, in one place. security definer so the policy on
-- team_members does not have to consult team_members and recurse.
create or replace function public.is_team_member(check_team uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.team_members m
    where m.team_id = check_team and m.user_id = auth.uid()
  );
$$;

drop policy if exists profiles_self on public.profiles;
create policy profiles_self on public.profiles
  for all using (id = auth.uid()) with check (id = auth.uid());

-- A team is readable by its members. Joining needs the code, which is handled
-- by join_team below rather than by opening this table up.
drop policy if exists teams_read on public.teams;
create policy teams_read on public.teams
  for select using (public.is_team_member(id));

drop policy if exists teams_insert on public.teams;
create policy teams_insert on public.teams
  for insert with check (owner_id = auth.uid());

drop policy if exists teams_update on public.teams;
create policy teams_update on public.teams
  for update using (owner_id = auth.uid());

drop policy if exists members_read on public.team_members;
create policy members_read on public.team_members
  for select using (public.is_team_member(team_id));

drop policy if exists members_self_insert on public.team_members;
create policy members_self_insert on public.team_members
  for insert with check (user_id = auth.uid());

drop policy if exists members_self_delete on public.team_members;
create policy members_self_delete on public.team_members
  for delete using (user_id = auth.uid());

do $$
declare t text;
begin
  foreach t in array array['lists', 'ads', 'ad_scores', 'canvases', 'canvas_runs'] loop
    execute format('drop policy if exists %1$s_member on public.%1$s', t);
    execute format(
      'create policy %1$s_member on public.%1$s for all
         using (public.is_team_member(team_id))
         with check (public.is_team_member(team_id))', t);
  end loop;
end $$;

-- list_ads carries no team_id of its own, so it borrows its list's.
drop policy if exists list_ads_member on public.list_ads;
create policy list_ads_member on public.list_ads
  for all
  using (exists (select 1 from public.lists l
                 where l.id = list_id and public.is_team_member(l.team_id)))
  with check (exists (select 1 from public.lists l
                      where l.id = list_id and public.is_team_member(l.team_id)));

-- canvas_nodes and canvas_edges carry no team_id of their own, so they borrow
-- their canvas's, exactly as list_ads borrows its list's.
do $$
declare t text;
begin
  foreach t in array array['canvas_nodes', 'canvas_edges'] loop
    execute format('drop policy if exists %1$s_member on public.%1$s', t);
    execute format(
      'create policy %1$s_member on public.%1$s for all
         using (exists (select 1 from public.canvases c
                        where c.id = canvas_id and public.is_team_member(c.team_id)))
         with check (exists (select 1 from public.canvases c
                             where c.id = canvas_id and public.is_team_member(c.team_id)))', t);
  end loop;
end $$;

-- A node or edge change has to move its canvas, or a pull filtering on
-- canvases.updated_at never learns that the brief was edited. One cursor per
-- team instead of a second one per child table.
create or replace function public.touch_parent_canvas()
returns trigger language plpgsql as $$
declare parent uuid;
begin
  if tg_op = 'DELETE' then parent := old.canvas_id;
  else parent := new.canvas_id; end if;
  update public.canvases set updated_at = now() where id = parent;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

-- Deliberately not security definer: it runs as the caller, who just wrote the
-- node and is therefore a member, so canvases_member passes on its own.
do $$
declare t text;
begin
  foreach t in array array['canvas_nodes', 'canvas_edges'] loop
    execute format('drop trigger if exists %1$s_touch_parent on public.%1$s', t);
    execute format(
      'create trigger %1$s_touch_parent after insert or update or delete
         on public.%1$s for each row
         execute function public.touch_parent_canvas()', t);
  end loop;
end $$;

-- ------------------------------------------------------------------ joining
--
-- Joining is the one operation that has to see a team you are not yet in, so
-- it runs as a definer function against the code rather than by relaxing the
-- read policy on teams.

create or replace function public.join_team(code text)
returns public.teams
language plpgsql
security definer
set search_path = public
as $$
-- Not named "found": that is PL/pgSQL's own result flag, and shadowing it
-- makes "if not found" negate this record instead of the flag.
declare team public.teams;
begin
  -- A definer function runs with the owner's rights, so it has to check the
  -- caller itself. Without this an anonymous caller could guess codes, and
  -- would fail later with a confusing not-null violation rather than a clear
  -- refusal.
  if auth.uid() is null then
    raise exception 'sign in before joining a team';
  end if;

  select * into team from public.teams t where t.join_code = upper(trim(code));
  if team.id is null then
    raise exception 'no team with that code';
  end if;

  insert into public.team_members (team_id, user_id)
  values (team.id, auth.uid())
  on conflict do nothing;

  return team;
end;
$$;

-- The owner is a member from the start.
create or replace function public.add_owner_as_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.team_members (team_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists teams_owner_member on public.teams;
create trigger teams_owner_member
  after insert on public.teams
  for each row execute function public.add_owner_as_member();

-- updated_at, so pulls can ask for "changed since".
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['lists', 'ads', 'ad_scores', 'canvases', 'canvas_nodes', 'canvas_runs'] loop
    execute format('drop trigger if exists %1$s_touch on public.%1$s', t);
    execute format(
      'create trigger %1$s_touch before update on public.%1$s
         for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;

-- join_team is security definer, so its grant is the whole access control.
revoke all on function public.join_team(text) from public, anon;
grant execute on function public.join_team(text) to authenticated;

revoke all on function public.is_team_member(uuid) from public, anon;
grant execute on function public.is_team_member(uuid) to authenticated;

-- ---------------------------------------------------------------- ai usage
--
-- Metering for the Claude proxy in supabase/functions/claude. Rows are per
-- user per day. A caller can read and add to their own and nobody else's, so
-- the ceiling cannot be cleared by the client that is subject to it.

create table if not exists public.ai_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day     date not null default current_date,
  calls   int  not null default 0,
  tokens  bigint not null default 0,
  primary key (user_id, day)
);

alter table public.ai_usage enable row level security;

drop policy if exists ai_usage_self on public.ai_usage;
create policy ai_usage_self on public.ai_usage
  for select using (user_id = auth.uid());

grant select on public.ai_usage to authenticated;
revoke all on public.ai_usage from anon;

create or replace function public.ai_usage_today()
returns int
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(
    (select calls from public.ai_usage
     where user_id = auth.uid() and day = current_date),
    0);
$$;

-- Definer, and deliberately additive only: there is no path here that lowers a
-- count, so a caller cannot reset their own meter.
create or replace function public.ai_usage_record(tokens bigint default 0)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;

  insert into public.ai_usage (user_id, day, calls, tokens)
  values (auth.uid(), current_date, 1, greatest(tokens, 0))
  on conflict (user_id, day) do update
    set calls  = public.ai_usage.calls + 1,
        tokens = public.ai_usage.tokens + greatest(excluded.tokens, 0);
end;
$$;

revoke all on function public.ai_usage_today() from public, anon;
revoke all on function public.ai_usage_record(bigint) from public, anon;
grant execute on function public.ai_usage_today() to authenticated;
grant execute on function public.ai_usage_record(bigint) to authenticated;
