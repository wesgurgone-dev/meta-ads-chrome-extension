/**
 * The canvas as data: what a generation sees, and when a stored run stops
 * answering the question the graph is now asking. Pure, so:
 *   node tests/canvas.test.mjs
 */
import {
  PROMPT_VERSION,
  RUN_SCHEMA,
  SYSTEM,
  buildUserMessage,
  graphInputs,
  inputDigest,
  isStale,
  outputNode,
  runtimeSeconds,
  snapshotOf,
  wiredReferences,
} from "../src/canvas/model.js";
import { runToText } from "../src/canvas/generate.js";

let pass = 0,
  fail = 0;
const ok = (c, m) => {
  c ? pass++ : fail++;
  console.log(`${c ? "ok  " : "FAIL"} ${m}`);
};
const eq = (a, b, m) =>
  ok(
    JSON.stringify(a) === JSON.stringify(b),
    `${m}${JSON.stringify(a) === JSON.stringify(b) ? "" : ` (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`}`,
  );

const ad = (id, over = {}) => ({
  id,
  pageName: `Brand ${id}`,
  title: "Hydration that works",
  body: "Three minerals, no sugar.",
  ctaText: "Shop now",
  linkUrl: "https://example.com",
  thumbDataUrl: "data:image/jpeg;base64,AAAA",
  media: [{ type: "video", hdUrl: "https://cdn/x.mp4" }],
  ...over,
});

const canvasOf = (nodes, edges) => ({ id: "c1", spaceId: "s1", name: "Brief", nodes, edges });
const base = () =>
  canvasOf(
    [
      { id: "out", kind: "output", note: "60s UGC for TikTok, women 25-34" },
      { id: "n1", kind: "reference", adId: "1", note: "the hook" },
      { id: "n2", kind: "reference", adId: "2", note: "the lighting" },
      { id: "n3", kind: "reference", adId: "3", note: "ignore me" },
    ],
    [
      { from: "n1", to: "out" },
      { from: "n2", to: "out" },
    ],
  );

console.log("--- the snapshot is text, and only text ---");
const snap = snapshotOf(ad("1"));
eq(snap.pageName, "Brand 1", "the advertiser travels");
eq(snap.format, "video", "and the format");
ok(!("thumbDataUrl" in snap), "the local thumbnail does not: it is a data URL and would bloat the canvas");
ok(!("media" in snap), "nor do media URLs, which are signed and dead within hours");
ok(/ads\/library\/\?id=1/.test(snap.libraryUrl), "the library link is reconstructible from the archive id alone");

console.log("\n--- only wired nodes are inputs ---");
const canvas = base();
eq(wiredReferences(canvas).map((n) => n.id), ["n1", "n2"], "an unconnected node is not in the brief");
eq(outputNode(canvas).id, "out", "the output node is found by kind");
const inputs = graphInputs(canvas, { 1: ad("1") });
eq(inputs.map((i) => i.adId), ["1", "2"], "in graph order");
eq(inputs.map((i) => i.inLibrary), [true, false], "and each says whether its ad is still in the library");

console.log("\n--- a deleted ad degrades its node, it does not blank it ---");
const withSnapshot = canvasOf(
  [
    { id: "out", kind: "output", note: "" },
    { id: "n1", kind: "reference", adId: "9", note: "the humour", snapshot: snapshotOf(ad("9")) },
  ],
  [{ from: "n1", to: "out" }],
);
const gone = graphInputs(withSnapshot, {});
eq(gone[0].inLibrary, false, "the ad is gone");
eq(gone[0].note, "the humour", "the note somebody wrote is not");
eq(gone[0].snapshot.pageName, "Brand 9", "and neither is what the ad said");
const text = buildUserMessage(gone, "");
ok(/no longer in the library/.test(text), "the prompt says so rather than pretending");

console.log("\n--- the prompt carries the notes as the brief ---");
const full = buildUserMessage(graphInputs(canvas, { 1: ad("1"), 2: ad("2") }), outputNode(canvas).note);
ok(/The brief:\n60s UGC for TikTok/.test(full), "the output node's own brief leads");
ok(/Take from this one: the hook/.test(full), "each reference carries its instruction");
ok(/Take from this one: the lighting/.test(full), "all of them");
ok(!/ignore me/.test(full), "and an unwired node is nowhere in it");
ok(/2 references above/.test(full), "the count is stated so a dropped reference is visible");
const bare = buildUserMessage(
  graphInputs(canvasOf([{ id: "out", kind: "output" }, { id: "n1", kind: "reference", adId: "1", note: "" }],
                       [{ from: "n1", to: "out" }]), { 1: ad("1") }),
  "",
);
ok(/nothing specified/.test(bare), "a reference with no note says so instead of being silently averaged in");

console.log("\n--- the system prompt holds the rules that make it shootable ---");
ok(/Never reuse a reference's exact wording/.test(SYSTEM), "no copying");
ok(/one person with a phone/.test(SYSTEM), "shootable");
ok(!/\$\{/.test(SYSTEM), "and nothing is interpolated into it");

console.log("\n--- the digest notices every edit that changes the answer ---");
const digest = inputDigest(canvas);
eq(inputDigest(base()), digest, "the same graph digests the same");
ok(inputDigest(canvasOf(
  canvas.nodes.map((n) => (n.id === "n1" ? { ...n, note: "the hook, and the pacing" } : n)),
  canvas.edges)) !== digest, "editing a note changes it");
ok(inputDigest(canvasOf(
  canvas.nodes.map((n) => (n.id === "out" ? { ...n, note: "30s, Instagram" } : n)),
  canvas.edges)) !== digest, "editing the brief changes it");
ok(inputDigest(canvasOf(canvas.nodes, [...canvas.edges, { from: "n3", to: "out" }])) !== digest,
   "wiring another reference in changes it");
ok(inputDigest(canvasOf(canvas.nodes, [{ from: "n1", to: "out" }])) !== digest,
   "and cutting one changes it");
eq(inputDigest(canvasOf(
  canvas.nodes.map((n) => (n.id === "n1" ? { ...n, x: 999, y: 999 } : n)),
  canvas.edges)), digest, "but moving a node on screen does not: layout is not the brief");
ok(inputDigest(canvasOf(
  [{ id: "out", kind: "output", note: "a" },
   { id: "n1", kind: "reference", adId: "1", note: "bc" }],
  [{ from: "n1", to: "out" }])) !==
   inputDigest(canvasOf(
  [{ id: "out", kind: "output", note: "ab" },
   { id: "n1", kind: "reference", adId: "1", note: "c" }],
  [{ from: "n1", to: "out" }])),
   "and two notes cannot be rearranged into the same digest");

console.log("\n--- a run knows when its brief has moved on ---");
const run = {
  canvasId: "c1",
  inputDigest: digest,
  model: "claude-opus-5",
  promptVersion: PROMPT_VERSION,
  createdAt: Date.UTC(2026, 8, 14),
  concept: "One take, kitchen bench",
  shotList: [
    { n: 1, seconds: 3, shot: "Hands tearing a sachet, tight", why: "the hook, from reference 1" },
    { n: 2, seconds: 12, shot: "Pour and stir, natural window light", why: "lighting, from reference 2" },
  ],
  script: [{ at: "0-3s", line: "You are not tired. You are dehydrated.", on_screen: "no sugar" }],
  notes: "Reference 3 was not wired in.",
  inputs: [{ adId: "1", note: "the hook", inLibrary: true, pageName: "Brand 1" }],
};
ok(!isStale(run, canvas), "a run made from this graph is current");
ok(isStale(run, canvasOf(canvas.nodes, [{ from: "n1", to: "out" }])), "cutting an edge makes it stale");
ok(!isStale(null, canvas), "and nothing at all is not stale");
eq(runtimeSeconds(run.shotList), 15, "the runtime is the shot list's own sum");
eq(runtimeSeconds(null), 0, "and an empty list runs zero seconds");

console.log("\n--- the schema forces a shootable shape ---");
const shot = RUN_SCHEMA.properties.shot_list.items;
eq(shot.required, ["n", "seconds", "shot", "why"], "every shot states why it is there");
ok(shot.properties.seconds.maximum === 60, "no single 10-minute shot");
eq(RUN_SCHEMA.properties.script.items.required, ["at", "line", "on_screen"],
   "and every line is keyed to a time");
ok(RUN_SCHEMA.additionalProperties === false, "nothing else comes back");

console.log("\n--- the export is something you can take to a shoot ---");
const out = runToText(run, "Hydration brief");
ok(/SHOT LIST/.test(out) && /SCRIPT/.test(out), "both halves are in it");
ok(/1\. \(3s\) Hands tearing a sachet/.test(out), "with times");
ok(/why: the hook, from reference 1/.test(out), "and the reason each beat exists");
ok(/Brand 1 \(the hook\)/.test(out), "the references it came from are named");
ok(new RegExp(PROMPT_VERSION).test(out), "and the prompt version, so two drafts are comparable");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
