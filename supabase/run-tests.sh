#!/usr/bin/env bash
# Applies schema.sql to a throwaway Postgres and runs the RLS tests against it.
#
# Nothing here touches a real project: it stubs the handful of Supabase pieces
# the schema leans on (auth.users, auth.uid) and runs as a non-superuser,
# because a superuser bypasses RLS and would pass whatever the policies said.
set -euo pipefail

PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
DIR=${DIR:-/var/tmp/pgval}
PORT=${PORT:-55432}
export PATH="$PGBIN:$PATH"

if ! psql -h "$DIR/sock" -p "$PORT" -U postgres -tAc 'select 1' >/dev/null 2>&1; then
  rm -rf "$DIR"; mkdir -p "$DIR/data" "$DIR/sock"
  chmod 755 "$DIR"; chown -R nobody "$DIR" 2>/dev/null || true
  su -s /bin/sh nobody -c "PATH=$PGBIN:\$PATH initdb -D $DIR/data -U postgres -A trust" >/dev/null
  su -s /bin/sh nobody -c "PATH=$PGBIN:\$PATH pg_ctl -D $DIR/data -o '-p $PORT -k $DIR/sock' -l $DIR/log start" >/dev/null
  sleep 3
fi

P="psql -h $DIR/sock -p $PORT -U postgres -v ON_ERROR_STOP=1"
$P -q -c 'drop database if exists val;' -c 'create database val;' >/dev/null 2>&1
# The Supabase environment the schema is written against: the two roles every
# project has, plus the auth pieces the policies call. The roles have to exist
# before the schema runs, because it grants and revokes against them.
# Roles are cluster-wide, not per-database, so they survive a dropped database.
$P -d val -q -c "do \$\$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon')
      then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated')
      then create role authenticated nologin; end if;
  end \$\$;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  grant usage on schema auth to anon, authenticated;
  grant select on auth.users to anon, authenticated;
  create function auth.uid() returns uuid language sql stable as \$\$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid; \$\$;" >/dev/null
$P -d val -q -f "$(dirname "$0")/schema.sql" 2>/dev/null
$P -d val -f "$(dirname "$0")/rls.test.sql" 2>&1 | grep -E '^[0-9]+\.|^ t$|^ f$|ERROR'
