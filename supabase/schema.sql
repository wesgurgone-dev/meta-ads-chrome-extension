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
  public.lists, public.ads, public.list_ads
  to authenticated;

revoke all on
  public.profiles, public.teams, public.team_members,
  public.lists, public.ads, public.list_ads
  from anon;

-- ------------------------------------------------------------- row security

alter table public.profiles     enable row level security;
alter table public.teams        enable row level security;
alter table public.team_members enable row level security;
alter table public.lists        enable row level security;
alter table public.ads          enable row level security;
alter table public.list_ads     enable row level security;

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
  foreach t in array array['lists', 'ads'] loop
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
  foreach t in array array['lists', 'ads'] loop
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
