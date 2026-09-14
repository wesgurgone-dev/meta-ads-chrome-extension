# Team spaces on Supabase

## What goes where, and what must never be committed

| Thing | Where it lives |
| --- | --- |
| `schema.sql` | Run once in your project's **SQL Editor** |
| Project URL and **anon / publishable** key | Entered in the extension's Settings, stored in `chrome.storage.local` |
| Database password, `service_role` key | **Nowhere near this repo or the extension** |

The extension only ever uses the anon key. That key is safe to hand to a
browser: it carries no privileges of its own, and every row it can reach is
decided by the policies in `schema.sql`. The `service_role` key bypasses RLS
completely, and the database password is the Postgres superuser, so neither
belongs in client code, a config file, or a commit.

Nothing here needs the database password. `schema.sql` is applied by you in the
SQL editor, and the extension talks to PostgREST over HTTPS with the anon key.

## Applying it

Open the SQL Editor in your project, paste `schema.sql`, run it. It is
idempotent, so re-running after an edit is fine.

## Testing it

```
npm run test:sql
```

That starts a throwaway Postgres, stubs the two Supabase pieces the schema
leans on (`auth.users`, `auth.uid()`), applies the schema and runs
`rls.test.sql` against it **as a non-superuser**. That last part matters: a
superuser bypasses RLS entirely, so a test run as `postgres` would pass no
matter what the policies said.

The nine checks are the ones worth having: the owner is a member from the
start, a member sees their team's rows, a **non-member sees nothing and can
write nothing**, a join code grants access and a wrong one is refused, the same
ad saved twice upserts instead of duplicating, `updated_at` moves so
"changed since" pulls work, and a soft delete hides a row without removing it.

The suite has earned its place twice. First, `join_team` declared a record
variable called `found`, which shadows PL/pgSQL's own result flag, so
`if not found` negated a record instead of the flag and the function raised for
every caller.

Second, and only visible against a real project: the schema shipped **no table
grants at all**. RLS decides which rows a role may touch; it does not grant the
role the right to touch the table. A superuser in the SQL editor never feels
that, and the test did not either, because the test granted the privileges to
itself before running. The first signed-in user would have hit `permission
denied for table ads`. The grants are in the schema now, the test issues none,
and a tenth check confirms an anonymous caller holding the publishable key is
refused at the privilege check before RLS is even consulted.

## The two decisions that shape everything else

**`unique (team_id, archive_id)` on `ads`.** Two people saving the same ad is
the normal case, not a conflict, so every write is an upsert onto this
constraint. Without it the same creative arrives once per teammate.

**`deleted_at` instead of `DELETE`.** A device that was offline when something
was removed still holds it, and on its next push it would helpfully put it
back. Tombstones also give undo for free.
