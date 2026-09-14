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
  scoreColor,
  validateScore,
} from "../src/rank/schema.js";
import {
  FAILURE,
  MODEL,
  adFacts,
  buildMessages,
  collectImages,
  failureMessage,
  isBlocking,
  splitDataUrl,
} from "../src/rank/call.js";
import { toMarkdown } from "../src/understand/schema.js";

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
eq(axisProps, ["evidence", "beat", "band", "score"], "field order is evidence, beat, band, score");
eq(SCORE_SCHEMA.properties.rubric_version.enum, [RUBRIC_VERSION], "the version is pinned in the schema");
ok(SCORE_SCHEMA.additionalProperties === false, "no extra top-level keys");
eq(SCORE_SCHEMA.properties.axes.required, AXES, "all four axes are required");

console.log("\n--- validation catches a band that disagrees with its score ---");
const axis = (band, score) => ({ evidence: "a legible claim in the first beat", beat: "0-3s", band, score });
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

console.log("\n--- the model, and the cache floor that comes with it ---");
eq(MODEL, "claude-sonnet-5", "scoring runs on Sonnet 5");
// Sonnet 5 will not cache a prefix under 1024 tokens, and it fails silently:
// no error, just the rubric paid for in full on every single ad. The character
// floor here is a coarse proxy for that token floor - if a future edit trims
// the rubric, this is the assertion that should make somebody check the real
// count with messages.count_tokens before shipping it.
ok(
  RUBRIC.length >= 3800,
  `the rubric stays long enough to have a chance of caching on Sonnet (${RUBRIC.length} chars)`,
);

console.log("\n--- one number, red through green ---");
const rgb = (css) => css.match(/\d+/g).map(Number);
eq(rgb(scoreColor(0))[0], 0, "the hue at 0 is red");
ok(/hsl\(0, 78%/.test(scoreColor(0)), `0 is red (${scoreColor(0)})`);
ok(/hsl\(130, 78%/.test(scoreColor(10)), `10 is green (${scoreColor(10)})`);
ok(/hsl\(43, 78%/.test(scoreColor(5)), `5 is amber, not the linear midpoint (${scoreColor(5)})`);
// The curve is the whole point: a straight sweep put a 2 at orange, which reads
// as a warning rather than as a failure.
const hueOf = (n) => Number(scoreColor(n).match(/hsl\((\d+)/)[1]);
ok(hueOf(2) < 15, `a 2 is still red (hue ${hueOf(2)})`);
ok(hueOf(3) < 25, `and a 3 is red-orange (hue ${hueOf(3)})`);
ok(hueOf(8) > 85, `an 8 is green (hue ${hueOf(8)})`);
for (let n = 1; n <= 10; n++)
  ok(hueOf(n) > hueOf(n - 1), `${n} is greener than ${n - 1}`);
eq(scoreColor(7.9), scoreColor(7.9), "and it is a pure function of the score");
ok(/0%/.test(scoreColor(null)), "no score is grey, not red: absent is not bad");
eq(scoreColor(99), scoreColor(10), "a score above the scale clamps rather than wrapping the hue");
eq(scoreColor(-5), scoreColor(0), "and so does one below it");

console.log("\n--- a failure is a code, so the queue can tell them apart ---");
ok(isBlocking(FAILURE.NOT_DEPLOYED), "a missing deployment stops the whole queue");
ok(isBlocking(FAILURE.SIGNED_OUT), "so does an expired session");
ok(isBlocking(FAILURE.RATE_LIMITED), "and the daily cap");
ok(isBlocking(FAILURE.OFFLINE), "and no network");
ok(!isBlocking(FAILURE.NOTHING_TO_SEE), "an ad with no creative is that ad's problem, not the queue's");
ok(!isBlocking(FAILURE.BAD_REPLY), "and so is a reply that would not parse");
ok(
  /supabase functions deploy claude/.test(failureMessage(FAILURE.NOT_DEPLOYED)),
  "the 404 names the command that fixes it, rather than reading as a broken feature",
);
// Two different fixes, and the message has to name both: signing in, or the
// server-side switch that allows signed-out use.
ok(/sign in/i.test(failureMessage(FAILURE.SIGNED_OUT)), "a refused request offers signing in");
ok(/ALLOW_ANON/.test(failureMessage(FAILURE.SIGNED_OUT)), "and the switch that removes the need to");

console.log("\n--- what the model is shown ---");
const jpeg = "data:image/jpeg;base64,AAECAw==";
eq(splitDataUrl(jpeg), { mediaType: "image/jpeg", data: "AAECAw==" }, "a data URL splits into type and payload");
eq(splitDataUrl("https://cdn/x.jpg"), null, "a plain URL does not, because the API takes bytes");
eq(splitDataUrl(""), null, "and nothing is nothing");

const withFrames = collectImages(
  { id: "1", thumbDataUrl: jpeg },
  { frames: [{ t: 0, dataUrl: jpeg }, { t: 1.5, dataUrl: jpeg }] },
);
eq(withFrames.kind, "video", "frames win over the thumbnail");
eq(withFrames.images.length, 2, "and all of them are sent");
const stillOnly = collectImages({ id: "1", thumbDataUrl: jpeg }, { frames: [], error: "video too large" });
eq(stillOnly.kind, "still", "an ad whose frames failed falls back to the thumbnail");
ok(/video too large/.test(stillOnly.note), "and the prompt is told why it is looking at one image");
eq(collectImages({ id: "1" }, null).images.length, 0, "an ad with nothing to look at yields nothing");

// Scoring is text only now. The frames were watched once by the extraction
// pass; sending them again would pay for vision twice to learn nothing, and
// would make a re-score after a rubric edit as expensive as the first one.
const record = {
  product: { what: "electrolyte drink powder", niche: "sugar-free hydration", category: "drink mix", brand_role: "the advertiser sells it" },
  audience: { who: "endurance athletes", problem: "cramping on long rides" },
  claims: ["no sugar"],
  format: { kind: "demo", style: "kitchen bench", has_speech: true, on_screen_text: ["NO SUGAR"] },
  hook: { what_happens: "hands tear a sachet", device: "tight product open" },
  beats: [{ at: "0-3s", what: "hands tear a sachet", purpose: "hook" }],
  production: { lighting: "window light", framing: "tight", stability: "tripod", text_legibility: "large", edit: "clean", aspect: "9:16" },
  discovery: { search_terms: ["electrolyte powder"], adjacent_products: [], competitor_guesses: [] },
  summary: "A demo of an electrolyte powder.",
};
const md = toMarkdown(record, { pageName: "Hyro" });
const messages = buildMessages({ id: "1", pageName: "Hyro", body: "Three minerals." }, record, md);
eq(messages.length, 1, "one user message");
const kinds = messages[0].content.map((b) => b.type);
ok(!kinds.includes("image"), "no images: the record carries what the frames showed");
eq(kinds[kinds.length - 1], "text", "and the instruction comes last");
const sent = messages[0].content[0].text;
ok(/Body copy: Three minerals\./.test(sent), "the advertiser's own copy is included");
ok(/electrolyte drink powder/.test(sent), "and what the ad actually turned out to be");
ok(/0-3s/.test(sent), "with the beats, which is what the evidence cites");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
