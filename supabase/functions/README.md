# Edge Functions

## `claude` — the Anthropic proxy

The extension is client code. Anything it ships can be read by anyone who
installs it, so the Anthropic key cannot live there. This function holds the
key, and the extension calls the function.

```
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase functions deploy claude
```

The key is read from the environment and is never returned, logged or echoed in
an error. Upstream failures come back as a status and a generic message rather
than a forwarded body, because an upstream error body can carry request detail.

### What it checks, in order

1. **Signed in.** The caller's JWT, or 401.
2. **Model.** One of three, or 400. Not a free-text passthrough.
3. **Images.** At most 16, counted server-side rather than trusted from the
   client, because an image-heavy request is the expensive one.
4. **Team.** If the caller names a team, they must be in it. The check runs
   through the caller's own JWT, so the row policies do the work and the
   function cannot be tricked into reading another team's rows.
5. **Meter.** 400 calls per user per day, or 429.

### The meter

`public.ai_usage`, one row per user per day, defined in `../schema.sql`.

There is a `select` policy for your own row and no `update` policy at all, and
the recording function is `security definer` and additive only. A caller cannot
lower the count that limits them. Four checks in `../rls.test.sql` cover this,
including that the count survives an attempt to zero it and that one user cannot
read another's.

### Why a proxy rather than a key in Settings

Asking the user to paste their own Anthropic key would avoid this function
entirely. It also puts a working key in `chrome.storage.local` on every machine
the extension is installed on, readable by anything that can read extension
storage, and makes every user get their own billing relationship. The proxy
keeps one key in one place, and the same JWT that already protects the team's
ads protects the spend.
