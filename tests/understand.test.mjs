/**
 * The record the extraction pass writes, and what discovery does with it.
 * Pure, so: node tests/understand.test.mjs
 *
 * The assertions here protect the one thing this whole pass exists to fix: a
 * term extractor pointed at ad copy returns the advertiser's own words, which
 * finds the advertiser and nobody else.
 */
import {
  UNDERSTANDING_SCHEMA,
  UNDERSTANDING_VERSION,
  toMarkdown,
  validateUnderstanding,
} from "../src/understand/schema.js";
import { EXTRACT_SYSTEM, EXTRACT_VERSION } from "../src/understand/prompt.js";
import { EXTRACT_MODEL, buildExtractMessages } from "../src/understand/extract.js";
import { bestTerms, deriveTermsFromRecords } from "../src/discover/terms.js";

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

const record = (over = {}) => ({
  product: {
    what: "an electrolyte drink powder in single-serve sachets",
    category: "electrolyte drink mix",
    niche: "sugar-free hydration for endurance athletes",
    brand_role: "the advertiser sells it",
  },
  audience: { who: "cyclists and runners", problem: "cramping on long efforts" },
  claims: ["no sugar", "three minerals"],
  format: { kind: "demo", style: "kitchen bench UGC", has_speech: true, on_screen_text: ["NO SUGAR"] },
  hook: { what_happens: "hands tear a sachet in tight close-up", device: "tight product open" },
  beats: [
    { at: "0-3s", what: "hands tear a sachet", purpose: "hook" },
    { at: "3-12s", what: "pour and stir in window light", purpose: "demonstrate" },
  ],
  production: {
    lighting: "soft window light from camera left",
    framing: "tight, subject centred",
    stability: "tripod, steady",
    text_legibility: "large white caps on a dark bench, readable small",
    edit: "four cuts, no jarring jumps",
    aspect: "9:16",
  },
  discovery: {
    search_terms: ["electrolyte powder", "sugar free sports drink", "hydration multiplier"],
    adjacent_products: ["protein powder"],
    competitor_guesses: ["Liquid IV"],
  },
  summary: "A bench demo of a sugar-free electrolyte powder aimed at endurance athletes.",
  ...over,
});

console.log("--- the extraction prompt is frozen and aimed at the right target ---");
ok(!/\$\{/.test(EXTRACT_SYSTEM), "nothing is interpolated into it, so it stays a cache hit");
ok(EXTRACT_SYSTEM.length > 2000, "and it clears Opus 5's 512-token cacheable floor comfortably");
ok(/PRODUCTION IS OBSERVATION, NOT JUDGEMENT/.test(EXTRACT_SYSTEM),
   "it separates seeing from judging, so the scorer gets facts rather than opinions");
ok(/CATEGORY'S WORDS, NOT THIS BRAND'S/.test(EXTRACT_SYSTEM),
   "and it says whose vocabulary the search terms belong to, which is the whole point");
ok(/never "Hyro"/.test(EXTRACT_SYSTEM), "with a worked example of what not to return");
eq(EXTRACT_MODEL, "claude-opus-5",
   "watching runs on Opus 5: it is paid once per ad and everything else inherits how well it sees");

console.log("\n--- the record validates on the things downstream depends on ---");
ok(validateUnderstanding(record()).ok, "a full record passes");
ok(!validateUnderstanding(record({ product: { what: "", niche: "" } })).ok, "no product fails");
ok(!validateUnderstanding(record({ beats: [] })).ok, "no beats fails, because evidence cites them");
ok(!validateUnderstanding(record({ discovery: { search_terms: [] } })).ok,
   "and no search terms fails, because that is what discovery reads");
ok(!validateUnderstanding(null).ok, "and nothing at all fails");

console.log("\n--- production is described, never graded ---");
const prod = UNDERSTANDING_SCHEMA.properties.production.properties;
eq(Object.keys(prod).sort(),
   ["aspect", "edit", "framing", "lighting", "stability", "text_legibility"],
   "six observable properties");
ok(!Object.keys(prod).some((k) => /score|rating|quality|good/.test(k)),
   "and not one of them is a judgement the scorer should be making");

console.log("\n--- the markdown is a rendering, not a second source of truth ---");
const md = toMarkdown(record(), { pageName: "Hyro" });
ok(/# Hyro/.test(md), "it is headed by the advertiser");
ok(/sugar-free hydration for endurance athletes/.test(md), "carries the niche");
ok(/\*\*0-3s\*\* hands tear a sachet/.test(md), "the beats with their timestamps");
ok(/soft window light from camera left/.test(md), "and the production observations");
eq(toMarkdown(null), "", "no record renders to nothing rather than throwing");

console.log("\n--- extraction sends the copy, then the frames, then the task ---");
const msgs = buildExtractMessages("Advertiser: Hyro", [
  { label: "Frame 0 at 0.0s", mediaType: "image/jpeg", data: "AAA" },
  { label: "Frame 1 at 0.8s", mediaType: "image/jpeg", data: "BBB" },
]);
const kinds = msgs[0].content.map((b) => b.type);
eq(kinds.filter((k) => k === "image").length, 2, "both frames go");
eq(kinds[0], "text", "the copy leads");
eq(kinds[kinds.length - 1], "text", "and the instruction comes last");

console.log("\n--- discovery reads what the ad was, not what it said ---");
const seed = [{ pageName: "Hyro", linkUrl: "https://drinkhyro.com.au", body: "Hydration that works." }];
const derived = deriveTermsFromRecords([record(), record(), record()], { ads: seed });
eq(derived.source, "watched", "the source is named");
eq(derived.terms[0].term, "electrolyte powder", "the shared category term ranks first");
ok(derived.terms.every((t) => !/hydration that works|works/.test(t.term)),
   "the advertiser's slogan is nowhere in it");
eq(derived.niches[0], "sugar-free hydration for endurance athletes", "and the niche comes through");

console.log("\n--- a leaked brand term is filtered in code, not just forbidden in the prompt ---");
// One leaked brand name turns a niche sweep into a search for the advertiser
// you already have, and it looks like a working result.
const leaked = deriveTermsFromRecords(
  [record({ discovery: { search_terms: ["electrolyte powder", "Hyro", "drinkhyro sachets"] } }),
   record({ discovery: { search_terms: ["electrolyte powder"] } })],
  { ads: seed },
);
eq(leaked.terms.map((t) => t.term), ["electrolyte powder"], "the brand and its domain are dropped");

console.log("\n--- and it says honestly which source it used ---");
eq(bestTerms(seed, []).source, "copy", "no records falls back to the copy");
eq(bestTerms(seed, [record()]).source, "watched", "a record is preferred");
ok(bestTerms(seed, []).terms.length > 0, "the fallback still returns something usable");
eq(UNDERSTANDING_VERSION, "understanding_v1", "the record is versioned");
eq(EXTRACT_VERSION, "extract_v1", "and so is the prompt that produced it");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
