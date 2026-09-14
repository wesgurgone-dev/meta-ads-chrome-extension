# Roadmap: next four builds

## Where this stands

All four items are built. What follows the divider is the original design
document, kept because the reasoning in it is still the reasoning behind the
code; where the build departed from it, the departure is noted here and in the
commit that made it.

**1. Supabase team spaces - built.** Schema, row policies and grants are live on
the project and verified against it. Client, sign-in by emailed six-digit code,
Settings pane with a three-fact status readout, merge rules, push, pull-since,
and a realtime subscription that re-pulls on every wake.

**2. Competitor discovery - built.** No Apify actor and no Meta API returns
*similar* advertisers; every source takes a keyword or a page URL, which was the
load-bearing question and the answer reshaped the feature. Similarity is
manufactured instead: terms are derived from a list, searched as background Ad
Library tabs on the user's own session, and the advertisers that come back are
ranked on term coverage, domain proximity, ad volume and median days running,
with marketplaces and deals sites demoted and the reason shown. No scraper is
paid for. `src/discover/`, and the Discover tab in the dashboard.

**3. AI ad ranking - built.** Four anchored axes out of ten, scored by
`claude-opus-5` through the proxy. Frames are captured at save time in an
offscreen document, because a signed CDN link is dead by the time anyone clicks
Score. Scores cache on (ad, rubric version) locally and in the team.
`src/rank/`, `offscreen/`, and the Score panel in an ad's detail view.

**4. Node canvas - built.** Reference ads as nodes with a free-text note on each
saying what to take from it, wired into an output that writes a shot list and a
script. Hand-rolled, not React Flow: the measured cost was 177KB against 30KB of
headroom for a graph that is a star. `src/canvas/`, `dashboard/src/canvas.jsx`,
and the Workflow tab.

### Open, and blocked

**Sign-in.** The six-digit code never arrived. Most likely the default Magic Link
template renders only `{{ .ConfirmationURL }}` and never `{{ .Token }}`, so the
code is generated but never shown. The template to paste and the fallbacks are in
`supabase/README.md`. Until this clears, the authenticated path is proven against
a real Postgres (21 SQL checks) but not against the live project, which is what
blocks end-to-end testing of everything that needs a team.

### Open, and waiting on a deploy

**The Anthropic proxy.** `supabase secrets set ANTHROPIC_API_KEY=...` then
`supabase functions deploy claude`. Scoring and generation both go through it and
neither can run until it is up; `checkProxy()` in `src/supabase/ai.js` says which
of the two steps is missing. Everything either feature does *before* the call -
frame capture, term derivation, the graph, the caches - works without it.

**The schema.** `supabase/schema.sql` has grown `ad_scores` and the four canvas
tables since it was last applied. It is idempotent; re-run the whole file.

### Open, and small

- **Canvas sync is written but unproven.** `push`/`pull` carry canvases, nodes
  and edges, the merge rules are tested, and the realtime channel watches
  `canvases` (a node write touches its canvas, so one subscription covers all
  three). None of it has run against the live project, because sign-in has not
  succeeded. The one piece worth a second look when it does is the stale-row
  reap in `pushCanvases`, which builds a PostgREST `not.in` list of node uuids.
- **Frames are opt-out-less.** Capture spends background bandwidth on every saved
  video ad. It should be visible and disableable in Settings.
- **Scoring cost is unmeasured.** Use `messages.count_tokens` on representative
  frames before quoting a per-ad price; the old estimate predates thinking being
  on by default and the high-resolution vision tier.

### Where the build departed from the design below

- **Storage of generated output.** The design says store the graph and regenerate
  the script. The build stores runs. The output is not a pure function of the
  graph - the model is nondeterministic and two of its inputs decay - so
  regenerating is a new draft, not a refresh, and it re-bills. Staleness is
  marked against a digest instead of resolved by discarding.
- **A second Edge Function.** The design has a dedicated `rank-ad` function. The
  build reuses the one generic proxy, which already meters and checks membership,
  so there is one thing to deploy rather than three. The rubric and its schema
  are frozen constants in `src/rank/`.
- **React Flow.** Ruled out on a measured 177KB, not on the stale "no build step"
  reason the design gives.

## Standing decisions

- Local-only mode stays first class; sign-in is additive. The strongest claim
  this extension makes is that nothing leaves your machine, and a team feature
  that quietly revokes it is a different product. Scoring and generation do send
  content to a server, and that needs to stay a visible choice rather than a
  default nobody noticed.
- No credential ever reaches the repo or the bundle. The publishable key does,
  because that is what it is for; a test asserts no `service_role` key and no
  connection string are in the built bundles.
- SDF refraction is wired but off: in Chromium it replaces the backdrop rather
  than bending it. One prop away if that changes.

---

Written as a handoff. Current state is a serverless MV3 extension: capture,
spaces, colour-coded lists, side panel, HD downloads, themes. No build step, no
backend, no accounts. The four items below each break one of those properties,
so the order matters.

Recommended sequence: **1 -> 3 -> 2 -> 4.** Supabase comes first not because it
is the most interesting but because it gives you an Edge Function, which is the
only safe place to put the Anthropic key (item 3) and the Apify token (item 2).
Build item 3 before item 2 because ranking works on ads you already have, while
discovery invents new ones and is the item most likely to stall on scraper
behaviour you cannot control.

---

## 1. Supabase team spaces (live sync)

Replaces the current export/import bundle with real multi-user state.

### Schema

```
profiles        id (= auth.uid), display_name, created_at
teams           id, name, join_code (6 char, unique), owner_id, created_at
team_members    team_id, user_id, role, joined_at        PK (team_id, user_id)
lists           id, team_id, name, colour, position, created_by, deleted_at
ads             id, team_id, archive_id, advertiser, page_id, started_at,
                is_active, format, cta, link, body, thumb_url, hd_url,
                raw jsonb, created_by, created_at
                UNIQUE (team_id, archive_id)
list_ads        list_id, ad_id, added_by, added_at, deleted_at
                PK (list_id, ad_id)
```

Two things that are easy to get wrong and expensive to fix later:

- **`UNIQUE (team_id, archive_id)`** is what makes "two people save the same ad"
  idempotent. Upsert on that constraint, never insert blind.
- **Soft delete (`deleted_at`), not row delete.** Without tombstones an offline
  device that still holds a removed ad will helpfully re-insert it on its next
  push. Tombstones also give you undo for free.

Media URLs are stored but treated as disposable: Facebook CDN links are signed
and expire in hours. `hd_url` is a convenience for a download that happens soon
after the save, not an archive. If you ever want durable creatives, that is
Supabase Storage and a separate decision about bandwidth cost.

### RLS

Every table is scoped through membership, not through ownership:

```sql
create policy team_read on ads for select
  using (exists (select 1 from team_members m
                 where m.team_id = ads.team_id and m.user_id = auth.uid()));
```

Same shape for `lists`, `list_ads`, and writes. `teams` is readable by members
plus a narrow lookup by `join_code` so joining works before you are a member.
Test the policies by querying as a non-member and expecting zero rows, not an
error. Silent empty results are the RLS failure mode.

### Auth

`chrome.identity.launchWebAuthFlow` with Supabase OAuth, or magic link. Google
OAuth is the better experience for this audience (media buyers are already in a
Google session), magic link is far less setup. Start with magic link, add Google
later if sign-in friction shows up.

The redirect URL is `https://<extension-id>.chromiumapp.org/`. Add it to the
Supabase allowed redirect list. The extension id is stable once you publish, but
it changes on an unpacked reload unless you pin a `key` in the manifest, so pin
it now.

### MV3 constraints that will bite

- **The service worker dies after about 30 seconds of idle.** A realtime
  websocket cannot live there. Put the Supabase realtime subscription in the
  **dashboard page and the panel**, which are real documents with a normal
  lifetime, and have the service worker do only stateless request/response work.
  On every panel or dashboard open, reconcile first (pull changes since
  `last_synced_at`) and then subscribe. Do not assume the socket saw everything
  while you were closed.
- **No build step, and MV3 forbids remote code.** `supabase-js` has to be
  vendored as a local UMD bundle checked into `lib/`. Download it, commit it,
  load it with a `<script>` tag. Do not add a bundler for this; the
  no-build-step property is worth more than the ergonomics.
- **Only the anon / publishable key ships in the extension.** The
  `service_role` key bypasses RLS entirely and must never appear in extension
  source, a config file, or a commit. If it ever does, rotate it rather than
  deleting the commit.
- Add the Supabase project URL to `host_permissions`, and remember the CSP in
  `manifest.json` covers the dashboard page too.

### Migration from local storage

First sign-in should treat the existing local library as truth and push it up,
not wipe it. Write it as an explicit one-time "upload my library" step with a
count shown before it runs, and keep the local copy after the push. Sync is a
mirror, never a move.

### Open decision (still unanswered from last session)

Does local-only mode stay first class, or does sign-in become mandatory?

Keeping it optional means every write path needs two implementations and stays
that way forever. Making it mandatory is much less code and much less testing,
but it means the extension is useless offline and your saved research lives on a
server. My recommendation: **keep local-only as the default and make sign-in
purely additive**, because the single strongest thing this extension currently
says is "nothing goes to a third-party server". A team feature that quietly
revokes that is a different product. But it is your call and it changes roughly
a third of the item-1 work.

---

## 2. Competitor discovery (Apify)

New dashboard tab. Input is either an existing list or a set of advertisers;
output is a ranked set of advertisers in the same niche.

**The thing to know before you spend money:** Apify's Facebook Ad Library actors
search **by keyword or by page URL**. None of them implement "find advertisers
similar to this one". There is no similarity endpoint to buy. So the pipeline
has to manufacture similarity:

1. **Derive niche terms** from the ads you already hold: advertiser names, ad
   copy nouns, CTA types, and especially **landing-page domains** (the domain is
   the strongest niche signal you have and it is already in `link`).
2. **Search** the Ad Library for those terms.
3. **Cluster** the returned advertisers by how many of your terms they hit, and
   rank by term overlap plus ad volume plus days running.

Step 1 is a small Claude call and shares the item-3 plumbing, which is another
reason to build item 3 first.

**The free alternative worth costing out honestly.** You already have a working
GraphQL interceptor. Opening a background tab on an Ad Library keyword search
and letting the existing interceptor capture the results gets you steps 2 and 3
with no Apify account, no token, and no per-result billing. It is slower, it is
visible to the user as a tab, and it is more fragile if Meta changes the page.
But it reuses code you have already debugged. I would prototype the
background-tab version first and only reach for Apify if throughput is the
blocker.

If you do use Apify: the token goes in a Supabase Edge Function, same as the
Anthropic key. Never in the extension.

---

## 3. AI ad ranking

Score each saved ad out of 10 on four axes: hook, utility, succinctness,
production quality.

### Model

`claude-opus-5`. Ranking creative is a judgement task where the ceiling matters
more than the price, and the volume here is small (you score an ad once, not per
view). Use adaptive thinking: `thinking: {type: "adaptive"}`. Do not pass
`budget_tokens`, it is rejected on Opus 5.

Rough cost per ad at 8 frames plus transcript: about 14k input and 800 output,
so roughly **9 cents per ad on Opus 5**, or about **3.5 cents on Sonnet 5** if
you want a cheaper bulk pass. A sensible split is Sonnet 5 for a first pass over
a whole list and Opus 5 on demand for the ads that matter.

### Input to the model

Video cannot be sent directly, so: **frames plus transcript**.

- Sample 8 to 12 frames. Weight them to the front: the hook axis is decided in
  the first 3 seconds, so take frames at roughly 0, 0.5, 1, 2, 3 seconds and
  then spread the rest evenly.
- Extract frames with a `<video>` plus `<canvas>` inside a `chrome.offscreen`
  document. That is the only place in MV3 with a DOM and no visible tab. Seek,
  draw, `toDataURL('image/jpeg', 0.7)`.
- **Grab frames while the signed URL is fresh.** Doing it at save time is more
  reliable than at rank time, when the URL has usually expired. Storing about 10
  small JPEGs per ad is also much cheaper than storing the video.
- Transcript: no free path here. Either send frames only and accept that the
  utility axis is weaker, or run audio through a transcription service. Start
  frames-only, measure how wrong it is, then decide.

### Rubric

Anchored, per axis, in the prompt. Unanchored 1 to 10 scales collapse into
everything scoring 7. For each axis define what a 2, a 5, and a 9 look like
concretely, and require the model to quote the specific moment that justifies
the score. Return structured output: score, one-line justification, and the
timestamp or frame index it is pointing at. The justification is what makes the
feature trustworthy; a bare number is noise.

Version the prompt (`rubric_v1`) and store that version on the score row. When
you change the rubric, old scores are not comparable and you need to know which
are which.

### Plumbing

- Key lives in a **Supabase Edge Function**. The extension calls the function,
  the function calls Anthropic. An API key in extension source is readable by
  anyone who installs it.
- Cache on `(ad_id, rubric_version)`. Never re-score on render.
- Rate limit per user in the Edge Function. Without it one "rank this list of
  400" click is a forty dollar afternoon.
- Score rows are per team, not per user, so a teammate's scoring benefits
  everyone.

---

## 4. Node canvas (later)

Sketch only, since this is explicitly not immediate.

Weavy-style graph where reference ads are nodes, each with free-text fields
saying what to pull from it (hook, script, product shots, lighting, humour), all
feeding an output node that generates a shot list and script.

The parts worth deciding early, even if you build none of it yet:

- **Store the graph, not the output.** Nodes, edges, and per-node extraction
  notes as a JSON document per project. The generated script is a render of the
  graph and should be regenerable, not a saved artifact you have to keep in sync.
- **The per-node text fields are the actual product.** "Pull the hook from this
  one, the lighting from that one" is the whole idea; the canvas is just how you
  express it. If you ever need to ship this in half the time, a plain list of
  reference ads with a text field beside each delivers most of the value with
  none of the canvas.
- Canvas library: no build step means no React Flow. Either accept a build step
  for this tab alone, or hand-roll SVG edges plus absolutely positioned nodes,
  which is very doable at this scale.
- It reuses item 3's frame extraction wholesale, which is a third argument for
  building item 3 early.

---

## Also still open

- **11 local commits are unpushed.** The Claude GitHub App is not installed for
  the `wesgurgone-dev` org, so pushes to this repo return 403 while reads work
  fine. Installing the app for the org unblocks it.
- `modern-web-guidance` was never installed; the non-interactive install was
  refused by the permission classifier. Run it locally, or name specific skills.
