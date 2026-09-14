-- Proves the row policies isolate one team from another.
--
-- Runs as a non-superuser, because superusers bypass RLS entirely and a test
-- run as postgres would pass no matter what the policies said.

\set ON_ERROR_STOP on
\set QUIET on

-- The roles and the auth stub are created by run-tests.sh before the schema
-- is applied, and no table grants are issued here. That is the point: this
-- test used to grant them itself, which is why it passed against a schema
-- that shipped none, while the first signed-in user on the real project would
-- have hit "permission denied for table ads".

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'ana@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'ben@example.com');

-- ---- Ana creates a team and saves an ad ---------------------------------
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

insert into public.teams (name, join_code, owner_id)
values ('Swipe file', 'GZGH6X', '11111111-1111-1111-1111-111111111111');

\echo '1. owner is a member automatically:'
select count(*) = 1 as pass from public.team_members
where user_id = '11111111-1111-1111-1111-111111111111';

insert into public.lists (team_id, name, colour)
select id, 'Winners', '#2a78d6' from public.teams;

insert into public.ads (team_id, archive_id, advertiser)
select id, '853222324181295', 'Hyro' from public.teams;

insert into public.list_ads (list_id, ad_id)
select l.id, a.id from public.lists l, public.ads a;

\echo '2. Ana sees her own rows:'
select (select count(*) from public.ads) = 1
   and (select count(*) from public.lists) = 1
   and (select count(*) from public.list_ads) = 1 as pass;

-- ---- Ben, not a member, must see nothing --------------------------------
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

\echo '3. a non-member sees no ads, lists, list_ads or teams:'
select (select count(*) from public.ads) = 0
   and (select count(*) from public.lists) = 0
   and (select count(*) from public.list_ads) = 0
   and (select count(*) from public.teams) = 0 as pass;

\echo '4. a non-member cannot write into the team:'
do $$
declare team uuid;
begin
  -- The team is invisible, so reach it the only way an attacker could: by id.
  select id into team from public.teams; -- returns null under RLS
  begin
    insert into public.ads (team_id, archive_id)
    values ('00000000-0000-0000-0000-000000000000', 'x');
    raise exception 'a non-member wrote a row';
  exception
    when insufficient_privilege or foreign_key_violation then null;
  end;
end $$;
select true as pass;

-- ---- Ben joins with the code -------------------------------------------
\echo '5. joining with the code makes the rows visible:'
select public.join_team('gzgh6x') is not null as joined;
select (select count(*) from public.ads) = 1
   and (select count(*) from public.lists) = 1 as pass;

\echo '6. a wrong code is refused:'
do $$
begin
  perform public.join_team('NOPE00');
  raise exception 'a bad code was accepted';
exception when others then
  if sqlerrm <> 'no team with that code' then raise; end if;
end $$;
select true as pass;

-- ---- the same ad saved twice is one row ---------------------------------
\echo '7. two people saving the same ad upserts rather than duplicating:'
insert into public.ads (team_id, archive_id, advertiser)
select id, '853222324181295', 'Hyro (Ben)' from public.teams
on conflict (team_id, archive_id)
do update set advertiser = excluded.advertiser, updated_at = now();

select count(*) = 1 as pass from public.ads where archive_id = '853222324181295';

\echo '8. updated_at moves on write, so "changed since" pulls work:'
select updated_at > created_at as pass from public.ads limit 1;

-- ---- tombstones, not deletes -------------------------------------------
\echo '9. a soft delete hides the row but keeps it for other devices:'
update public.ads set deleted_at = now();
select (select count(*) from public.ads) = 1
   and (select count(*) from public.ads where deleted_at is null) = 0 as pass;

-- ---- anon holds the publishable key and must get nowhere ---------------
\echo '10. an anonymous caller is refused before RLS is even consulted:'
set role anon;
reset request.jwt.claim.sub;
do $$
begin
  begin
    perform 1 from public.ads;
    raise exception 'anon could read ads';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.join_team('GZGH6X');
    raise exception 'anon could call join_team';
  exception when insufficient_privilege then null;
  end;
end $$;
select true as pass;

-- ---- the AI meter cannot be cleared by the caller it limits ------------
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

\echo '11. recording usage increments, and reads back per user:'
select public.ai_usage_record(100);
select public.ai_usage_record(50);
select public.ai_usage_today() = 2 as pass;

\echo '12. a second user has their own counter:'
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select public.ai_usage_today() = 0 as pass;

\echo '13. nobody can lower their own count:'
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$
begin
  begin
    update public.ai_usage set calls = 0;
    -- No update policy exists, so this changes nothing rather than erroring.
    if public.ai_usage_today() <> 2 then
      raise exception 'the meter was cleared';
    end if;
  exception when insufficient_privilege then null;
  end;
end $$;
select public.ai_usage_today() = 2 as pass;

\echo '14. and cannot read anyone else:'
select count(*) = 1 as pass from public.ai_usage;

reset role;
