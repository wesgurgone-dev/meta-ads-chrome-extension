/**
 * Merge rules for team spaces. Pure, so this runs in plain node:
 *   node tests/merge.test.mjs
 */
import { adFromRow, mergeAds, mergeCanvases, mergeLists, nextCursor, rowFromAd, rowsFromCanvas } from "../src/supabase/merge.js";

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

console.log("--- canvases sync whole, because the node text is the point ---");
const canvasRow = (over = {}) => ({
  id: "c1", name: "Hydration brief",
  created_at: "2026-01-20T10:00:00Z", updated_at: "2026-01-21T10:00:00Z",
  deleted_at: null, ...over,
});
const nodeRow = (id, over = {}) => ({
  id, canvas_id: "c1", kind: "reference", archive_id: "853222324181295",
  note: "the hook", snapshot: { pageName: "Hyro" }, x: 80, y: 60, deleted_at: null, ...over,
});

const fresh = mergeCanvases({
  localCanvases: {}, spaceId: "s1",
  canvasRows: [canvasRow()],
  nodeRows: [nodeRow("n1"), nodeRow("n2", { kind: "output", archive_id: null, note: "60s UGC" })],
  edgeRows: [{ canvas_id: "c1", from_node: "n1", to_node: "n2", deleted_at: null }],
});
eq(Object.keys(fresh.canvases), ["c1"], "a teammate's canvas adopts its remote id as the local one");
eq(fresh.canvases.c1.nodes.length, 2, "with its nodes");
eq(fresh.canvases.c1.nodes[0].note, "the hook", "and the note, which is the work");
eq(fresh.canvases.c1.edges, [{ from: "n1", to: "n2" }], "and its wiring");
eq(fresh.canvases.c1.spaceId, "s1", "filed into the space being synced");

const local = { c1: { id: "c1", spaceId: "s1", name: "Old name", nodes: [nodeRow("n1"), nodeRow("n9")], edges: [] } };
const replaced = mergeCanvases({
  localCanvases: local, spaceId: "s1",
  canvasRows: [canvasRow({ name: "Renamed" })],
  nodeRows: [nodeRow("n1")],
  edgeRows: [],
});
eq(replaced.canvases.c1.name, "Renamed", "a rename lands");
eq(replaced.canvases.c1.nodes.length, 1,
   "and nodes are replaced, not unioned: otherwise removing a node could never propagate");

const tombstoned = mergeCanvases({
  localCanvases: local, spaceId: "s1",
  canvasRows: [canvasRow({ deleted_at: "2026-01-22T10:00:00Z" })],
  nodeRows: [], edgeRows: [],
});
eq(Object.keys(tombstoned.canvases), [], "a deleted canvas goes");
eq(tombstoned.removed, ["c1"], "and is reported");

const untouched = mergeCanvases({
  localCanvases: local, spaceId: "s1", canvasRows: [], nodeRows: [], edgeRows: [],
});
eq(untouched.canvases.c1.nodes.length, 2, "a canvas the pull did not mention is left alone");

const partial = mergeCanvases({
  localCanvases: local, spaceId: "s1",
  canvasRows: [canvasRow()], nodeRows: [], edgeRows: [],
});
eq(partial.canvases.c1.nodes.length, 2,
   "and a canvas whose rows have not arrived keeps what it had, rather than rendering empty");

console.log("--- and the rows a canvas becomes honour the check constraint ---");
const rows = rowsFromCanvas(
  { id: "c1", name: "B",
    nodes: [{ id: "o", kind: "output", note: "brief", adId: "leaked", x: 1.4, y: 2.6 },
            { id: "n", kind: "reference", adId: "9", note: "hook", x: 0, y: 0 }],
    edges: [{ from: "n", to: "o" }] },
  "t1", "u1");
eq(rows.nodes[0].archive_id, null,
   "an output node never carries an ad id, whatever the local object holds");
eq(rows.nodes[1].archive_id, "9", "a reference always does");
eq(rows.nodes[0].x, 1, "coordinates are rounded, since real has no use for the fraction");
eq(rows.canvas.team_id, "t1", "the canvas is team scoped");
eq(rows.edges[0].from_node, "n", "and edges travel by node id");

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
