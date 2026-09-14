/**
 * Merge rules for team spaces. Pure, so this runs in plain node:
 *   node tests/merge.test.mjs
 */
import { adFromRow, mergeAds, mergeLists, nextCursor, rowFromAd } from "../src/supabase/merge.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok  " : "FAIL"} ${m}`); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}${JSON.stringify(a) === JSON.stringify(b) ? "" : ` (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`}`);

const row = (over = {}) => ({
  archive_id: "853222324181295",
  advertiser: "Hyro",
  started_at: "2026-01-15T00:00:00Z",
  ended_at: null,
  is_active: true,
  cta: "Shop now",
  link: "https://drinkhyro.com.au",
  body: "Hydration that works.",
  raw: { media: [{ type: "video", url: "https://cdn/x.mp4" }], platforms: ["FACEBOOK"], savedBy: "Ana" },
  created_at: "2026-01-20T10:00:00Z",
  updated_at: "2026-01-21T10:00:00Z",
  deleted_at: null,
  ...over,
});

console.log("--- a remote row becomes a local ad ---");
const ad = adFromRow(row());
eq(ad.id, "853222324181295", "archive id is the local id");
eq(ad.pageName, "Hyro", "advertiser");
eq(new Date(ad.startDate).toISOString().slice(0, 10), "2026-01-15", "start date");
eq(ad.ctaText, "Shop now", "cta");
eq(ad.media.length, 1, "media travels in raw");
eq(ad.savedBy, "Ana", "attribution survives");

console.log("--- and back again ---");
const back = rowFromAd(ad, "team-1");
eq(back.archive_id, "853222324181295", "archive id round-trips");
eq(back.team_id, "team-1", "scoped to the team");
eq(back.raw.media.length, 1, "media goes back into raw");
ok(back.deleted_at === null, "a pushed row is never a tombstone");

console.log("--- the local thumbnail survives a merge ---");
// It is a data URL captured at save time and never travels, so a merge that
// overwrites the record wholesale would silently blank every card.
const before = { "853222324181295": { id: "853222324181295", thumbDataUrl: "data:image/png;base64,AAA", pageName: "stale" } };
const { ads } = mergeAds(before, [row()]);
eq(ads["853222324181295"].thumbDataUrl, "data:image/png;base64,AAA", "thumbnail kept");
eq(ads["853222324181295"].pageName, "Hyro", "everything else takes the remote value");

console.log("--- a tombstone removes the ad ---");
const dead = mergeAds(before, [row({ deleted_at: "2026-02-01T00:00:00Z" })]);
ok(!dead.ads["853222324181295"], "row is gone locally");
eq(dead.removed, ["853222324181295"], "and is reported as removed");

console.log("--- an unknown tombstone is not an error ---");
const none = mergeAds({}, [row({ deleted_at: "2026-02-01T00:00:00Z" })]);
eq(Object.keys(none.ads).length, 0, "nothing to delete, nothing breaks");
eq(none.removed, [], "and nothing is reported");

console.log("--- lists ---");
const listRow = (over = {}) => ({
  id: "11111111-1111-1111-1111-111111111111",
  name: "Winners",
  colour: "#2a78d6",
  created_at: "2026-01-20T10:00:00Z",
  deleted_at: null,
  ...over,
});

console.log("    a teammate's new list is adopted");
let res = mergeLists({
  localLists: {}, spaceId: "space-1",
  listRows: [listRow()], listAdRows: [], knownAdIds: null,
});
eq(Object.keys(res.lists).length, 1, "one list");
eq(res.lists["11111111-1111-1111-1111-111111111111"].name, "Winners", "named");
eq(res.lists["11111111-1111-1111-1111-111111111111"].spaceId, "space-1", "in the right space");

console.log("    a rename reaches an existing local list");
res = mergeLists({
  localLists: { local1: { id: "local1", spaceId: "space-1", name: "Old", color: "#000", adIds: [], remoteId: "11111111-1111-1111-1111-111111111111" } },
  spaceId: "space-1",
  listRows: [listRow({ name: "Renamed", colour: "#eb6834" })],
  listAdRows: [], knownAdIds: null,
});
eq(res.lists.local1.name, "Renamed", "name updated in place");
eq(res.lists.local1.color, "#eb6834", "colour too");
eq(Object.keys(res.lists).length, 1, "and no duplicate was created");

console.log("    membership is replaced, so a removal propagates");
res = mergeLists({
  localLists: { local1: { id: "local1", spaceId: "space-1", name: "W", color: "#000", adIds: ["a", "b"], remoteId: "L1" } },
  spaceId: "space-1",
  listRows: [],
  listAdRows: [{ list_id: "L1", archive_id: "a", deleted_at: null }, { list_id: "L1", archive_id: "b", deleted_at: "2026-02-01T00:00:00Z" }],
  knownAdIds: null,
});
eq(res.lists.local1.adIds, ["a"], "the tombstoned member is dropped, not unioned back");

console.log("    a list nobody touched is left alone");
res = mergeLists({
  localLists: { local1: { id: "local1", spaceId: "space-1", name: "W", color: "#000", adIds: ["a"], remoteId: "L1" } },
  spaceId: "space-1", listRows: [], listAdRows: [], knownAdIds: null,
});
eq(res.lists.local1.adIds, ["a"], "membership untouched by an empty pull");

console.log("    a deleted list is removed locally");
res = mergeLists({
  localLists: { local1: { id: "local1", spaceId: "space-1", name: "W", color: "#000", adIds: [], remoteId: "L1" } },
  spaceId: "space-1", listRows: [listRow({ id: "L1", deleted_at: "2026-02-01T00:00:00Z" })],
  listAdRows: [], knownAdIds: null,
});
ok(!res.lists.local1, "gone");
eq(res.removed, ["local1"], "and reported");

console.log("--- the pull cursor ---");
eq(nextCursor([row({ updated_at: "2026-03-01T12:00:05Z" })], null), "2026-03-01T12:00:04.000Z",
   "one second of overlap, because rows written in the same second can land late");
eq(nextCursor([], "2026-03-01T12:00:00Z"), "2026-03-01T12:00:00Z", "an empty pull does not move the cursor");
// Left unguarded this walked backwards a second per quiet poll, so an idle
// space re-fetched further and further history every time.
let cursor = "2026-03-01T12:00:00Z";
for (let i = 0; i < 50; i++) cursor = nextCursor([], cursor);
eq(cursor, "2026-03-01T12:00:00Z", "and fifty quiet polls do not drift it backwards");
eq(nextCursor([row({ updated_at: "2026-03-01T12:00:00.500Z" })], "2026-03-01T12:00:00Z"),
   "2026-03-01T12:00:00Z", "nor does an overlap that would land behind the existing mark");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
