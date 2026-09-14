/**
 * The scoring rubric and its schema. Pure, so this runs in plain node:
 *   node tests/rank.test.mjs
 *
 * Two of these assertions exist because the failure they catch is invisible.
 * A rubric with anything interpolated into it still works - it just silently
 * stops being a cache hit, and the only symptom is the bill. A rubric edited
 * without bumping the version still works too - it just puts two different
 * scales on the same chart.
 */
import { readFileSync } from "node:fs";
import { RUBRIC, RUBRIC_VERSION } from "../src/rank/rubric.js";
import {
  AXES,
  BANDS,
  SCORE_SCHEMA,
  WEIGHTS,
  overallScore,
  validateScore,
} from "../src/rank/schema.js";
import { adFacts } from "../src/rank/index.js";

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

console.log("--- the rubric is a frozen string ---");
const rubricSource = readFileSync(new URL("../src/rank/rubric.js", import.meta.url), "utf8");
const literal = rubricSource.slice(
  rubricSource.indexOf("export const RUBRIC = `"),
  rubricSource.lastIndexOf("`;"),
);
ok(!literal.includes("${"), "nothing is interpolated into it, so it stays a cache hit");
ok(RUBRIC.length > 2000, "and it is long enough to clear the minimum cacheable prefix");
ok(/weak 1-3, competent 4-6, strong 7-8, exceptional 9-10/.test(RUBRIC), "the band mapping is stated");
ok(/ANTI-7 RULE/.test(RUBRIC), "and the anti-7 rule, which is what stops mid-scale drift");
for (const axis of ["HOOK", "UTILITY", "SUCCINCTNESS", "PRODUCTION QUALITY"])
  ok(RUBRIC.includes(`- ${axis}`), `${axis.toLowerCase()} is anchored`);

console.log("\n--- the schema forces evidence before the number ---");
const axisProps = Object.keys(SCORE_SCHEMA.properties.axes.properties.hook.properties);
eq(axisProps, ["evidence", "frame_index", "band", "score"], "field order is evidence, frame, band, score");
eq(SCORE_SCHEMA.properties.rubric_version.enum, [RUBRIC_VERSION], "the version is pinned in the schema");
ok(SCORE_SCHEMA.additionalProperties === false, "no extra top-level keys");
eq(SCORE_SCHEMA.properties.axes.required, AXES, "all four axes are required");

console.log("\n--- validation catches a band that disagrees with its score ---");
const axis = (band, score) => ({ evidence: "a legible claim by frame 1", frame_index: 0, band, score });
const result = (over = {}) => ({
  rubric_version: RUBRIC_VERSION,
  axes: {
    hook: axis("strong", 7),
    utility: axis("competent", 5),
    succinctness: axis("weak", 2),
    production: axis("exceptional", 10),
    ...over,
  },
});
ok(validateScore(result()).ok, "a consistent result passes");
ok(!validateScore(result({ hook: axis("strong", 3) })).ok, "a strong band scoring 3 fails");
ok(!validateScore(result({ hook: axis("gorgeous", 8) })).ok, "an invented band fails");
ok(
  !validateScore(result({ utility: { ...axis("competent", 5), evidence: "  " } })).ok,
  "a score with no evidence fails",
);
ok(!validateScore({ ...result(), rubric_version: "rubric_v0" }).ok, "an old rubric version fails");
ok(!validateScore(null).ok, "and nothing at all fails");

console.log("\n--- every band is reachable and the ranges do not overlap ---");
const covered = new Set();
for (const [band, [lo, hi]] of Object.entries(BANDS))
  for (let n = lo; n <= hi; n++) {
    ok(!covered.has(n), `${n} belongs to exactly one band (${band})`);
    covered.add(n);
  }
eq([...covered].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "1 through 10 are all covered");

console.log("\n--- the overall is weighted, not stored ---");
const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
ok(Math.abs(sum - 1) < 1e-9, "the weights sum to 1");
eq(overallScore(result().axes), 6.3, "hook-weighted mean of 7/5/2/10");
eq(overallScore({ hook: axis("strong", 8) }), 8, "a partial result weights only what it has");
eq(overallScore(null), null, "and nothing scores nothing");

console.log("\n--- ad facts carry the copy the frames cannot show ---");
const facts = adFacts({
  pageName: "Hyro",
  title: "Hydration that works",
  body: "Three minerals, no sugar.",
  ctaText: "Shop now",
  linkUrl: "https://drinkhyro.com.au",
  platforms: ["FACEBOOK", "INSTAGRAM"],
});
ok(/Advertiser: Hyro/.test(facts), "the advertiser");
ok(/Body copy: Three minerals, no sugar\./.test(facts), "the body copy, which carries the pitch");
ok(/Call to action: Shop now/.test(facts), "and the call to action");
ok(!/undefined|null/.test(facts), "missing fields are dropped rather than rendered as null");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
