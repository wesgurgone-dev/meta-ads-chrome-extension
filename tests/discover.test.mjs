/**
 * Competitor discovery: term derivation and advertiser ranking. Pure, so:
 *   node tests/discover.test.mjs
 *
 * The ranking is the part that regresses silently. A keyword search returns
 * everyone who used the word - the brands, their resellers, three marketplaces
 * and an affiliate comparison site - so if the ordering quietly degrades the
 * feature does not break, it just starts answering with noise.
 */
import { deriveTerms, registrableDomain, searchUrl, seedProfile } from "../src/discover/terms.js";
import { clusterAdvertisers, rankCompetitors, tokenOverlap } from "../src/discover/score.js";
import { MAX_TERMS, sweep, sweepFailed } from "../src/discover/sweep.js";

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

console.log("--- the registrable domain, which is the niche signal ---");
eq(registrableDomain("https://www.drinkhyro.com.au/collections/all?x=1"), "drinkhyro.com.au",
   "a two-part suffix keeps three labels");
eq(registrableDomain("https://shop.example.com"), "example.com", "a subdomain is dropped");
eq(registrableDomain("https://example.com"), "example.com", "a bare domain survives");
eq(registrableDomain("not a url"), null, "and junk is null rather than a throw");

console.log("\n--- terms come from what the ads share, not from one long body ---");
const seedAds = [
  { pageName: "Hyro", linkUrl: "https://drinkhyro.com.au", title: "Hydration that works",
    body: "Electrolyte hydration powder with three minerals and no sugar." },
  { pageName: "Hyro", linkUrl: "https://drinkhyro.com.au",
    body: "Our hydration powder beats sugary sports drinks. Electrolyte blend, no sugar." },
  { pageName: "Hyro", linkUrl: "https://drinkhyro.com.au",
    body: "A cleaner electrolyte hydration powder for athletes." },
];
const terms = deriveTerms(seedAds);
eq(terms[0].term, "hydration powder", "the phrase both ads share ranks first");
ok(terms.every((t) => !/hyro|drinkhyro/.test(t.term)), "the brand name is never a term");
ok(terms.every((t) => !/^(the|and|with|for|no)$/.test(t.term)), "nor are stopwords");
ok(terms.length <= MAX_TERMS, `at most ${MAX_TERMS} terms (${terms.length})`);
ok(
  !terms.some((a) => terms.some((b) => a !== b && b.term.includes(a.term))),
  "a bigram and one of its own words are never both kept",
);
eq(deriveTerms(seedAds), terms, "and the same ads derive the same terms every time");

const spam = [{ pageName: "Hyro", linkUrl: "https://drinkhyro.com.au",
  body: "sale sale sale sale sale sale sale sale sale sale sale" }];
ok(deriveTerms(spam).every((t) => t.ads <= 1), "one ad repeating a word cannot outvote a list");

console.log("\n--- searches are built for the Ad Library's own URL shape ---");
const url = searchUrl("hydration powder");
ok(/search_type=keyword_unordered/.test(url), "keyword search, not a page lookup");
ok(/q=hydration\+powder/.test(url), "the term is encoded");
ok(/active_status=active/.test(searchUrl("x")), "active ads by default");
ok(/active_status=all/.test(searchUrl("x", { activeOnly: false })), "and all of them on request");

console.log("\n--- ranking separates competitors from everyone else ---");
const now = Date.UTC(2026, 8, 14);
const ad = (n, o) => ({ id: `${o.pageId}-${n}`, isActive: true, startDate: now - 60 * 86400000, ...o });
const many = (count, o) => Array.from({ length: count }, (_, i) => ad(i, o));
const seed = seedProfile(seedAds);
const hits = [
  { term: "hydration powder", scanned: true, ads: [
    ...many(6, { pageName: "Saltd", pageId: "1", linkUrl: "https://saltd.co" }),
    ...many(3, { pageName: "Amazon", pageId: "9", linkUrl: "https://amazon.com.au/dp/x" }),
    ...many(2, { pageName: "Hyro", pageId: "5", linkUrl: "https://drinkhyro.com.au" }),
    ...many(4, { pageName: "Hydration Deals", pageId: "7", linkUrl: "https://hydrationdeals.com" }),
  ] },
  { term: "electrolyte hydration", scanned: true, ads: [
    ...many(5, { pageName: "Saltd", pageId: "1", linkUrl: "https://saltd.co" }),
    ...many(1, { pageName: "Lonely Brand", pageId: "8", linkUrl: "https://lonelybrand.com" }),
  ] },
];
const ranked = rankCompetitors(hits, seed, { now });
eq(ranked.map((r) => r.pageName), ["Saltd", "Lonely Brand", "Hydration Deals", "Amazon"],
   "two terms and real volume beats one term, a deals site and a marketplace");
ok(!ranked.some((r) => r.pageName === "Hyro"), "the seed's own advertiser is dropped");
ok(
  clusterAdvertisers(hits, seed, { now }).find((r) => r.pageName === "Hyro").isSeed,
  "but it is still visible as a seed when the whole cluster is asked for",
);
const amazon = ranked.find((r) => r.pageName === "Amazon");
ok(/marketplace/.test(amazon.reasons.join(" ")), "the marketplace says why it is last");
const deals = ranked.find((r) => r.pageName === "Hydration Deals");
ok(/review or deals/.test(deals.reasons.join(" ")), "and so does the deals site");
eq(ranked.find((r) => r.pageName === "Saltd").terms, ["electrolyte hydration", "hydration powder"],
   "terms are listed, sorted, so the reason is checkable");

console.log("\n--- ranking is deterministic ---");
const shuffled = [{ ...hits[1] }, { ...hits[0], ads: [...hits[0].ads].reverse() }];
eq(rankCompetitors(shuffled, seed, { now }).map((r) => r.pageName),
   ranked.map((r) => r.pageName), "the same hits in a different order rank identically");

console.log("\n--- an advertiser with no page id still clusters by name ---");
const byName = rankCompetitors(
  [{ term: "t", ads: [ad(0, { pageName: "Nameless", linkUrl: "https://nameless.com" }),
                      ad(1, { pageName: "Nameless", linkUrl: "https://nameless.com" })] }],
  seed, { now });
eq(byName.length, 1, "two ads, one row");
eq(byName[0].adCount, 2, "and both ads counted");
ok(/view_all_page_id/.test(ranked[0].libraryUrl), "a page id links straight to their library");
ok(/search_type=keyword_unordered/.test(byName[0].libraryUrl), "without one it falls back to a name search");

console.log("\n--- brand overlap is bounded ---");
eq(tokenOverlap("drinkhyro", "drinkhyro"), 1, "identical");
eq(tokenOverlap("hyro", "drinkhyro"), 1, "contained");
eq(tokenOverlap("saltd", "drinkhyro"), 0, "unrelated");
eq(tokenOverlap("", "drinkhyro"), 0, "and empty is not a match");

console.log("\n--- a sweep that read nothing is not an empty market ---");
ok(sweepFailed([{ term: "a", scanned: false }, { term: "b", scanned: false }]),
   "no term was ever read: that is a broken read");
ok(!sweepFailed([{ term: "a", scanned: true, ads: [] }]),
   "a term that was read and matched nothing is a real answer");
ok(!sweepFailed([]), "and no terms at all is neither");

console.log("\n--- the sweep drives background tabs and cleans up after itself ---");
// chrome.tabs is stubbed rather than driven through a browser: the orchestration
// worth testing is the polling, the stall detection, the cap and the cleanup,
// and all four are invisible in a UI run and obvious here.
const makeChrome = (script) => {
  const opened = [];
  const removed = [];
  let step = 0;
  globalThis.chrome = {
    runtime: { lastError: null },
    tabs: {
      create: async ({ url, active }) => {
        opened.push({ url, active });
        step = 0;
        return { id: opened.length };
      },
      remove: async (id) => {
        removed.push(id);
      },
      sendMessage: (tabId, msg, cb) => {
        const reply =
          typeof script === "function" ? script(step) : script[Math.min(step, script.length - 1)];
        step += 1;
        chrome.runtime.lastError = reply ? null : { message: "no receiver" };
        cb(reply || undefined);
      },
    },
  };
  return { opened, removed };
};

const reply = (captured, scanned = true) => ({ ok: true, ads: [], captured, scanned });
const fast = { pollMs: 1, stallMs: 3, maxMs: 400, dwellMs: 1 };

{
  // Two silent polls, then a count that grows, then a count that settles.
  const { opened, removed } = makeChrome([null, null, reply(2), reply(5), reply(5), reply(5)]);
  const hits = await sweep(["hydration powder"], fast);
  eq(hits.length, 1, "one term, one result");
  eq(hits[0].captured, 5, "the settled count is what is reported");
  eq(hits[0].reason, "settled", "and it stopped because the page went quiet, not on a timeout");
  eq(opened.length, 1, "one tab was opened");
  ok(opened[0].active === false, "in the background, never stealing focus");
  ok(/search_type=keyword_unordered/.test(opened[0].url), "at a keyword search URL");
  eq(removed, [1], "and it was closed again");
}

{
  // A page that never stops growing must still end.
  const { removed } = makeChrome((step) => reply(step + 1));
  const hits = await sweep(["endless"], { ...fast, maxMs: 60 });
  eq(hits[0].reason, "timeout", "a page that never settles is cut off");
  eq(removed.length, 1, "and its tab is still closed");
}

{
  // A tab that never answers is a failed read, not an empty market.
  const { removed } = makeChrome([null]);
  const hits = await sweep(["silent"], { ...fast, maxMs: 30 });
  eq(hits[0].scanned, false, "nothing was read");
  ok(sweepFailed(hits), "so the sweep is reported as failed rather than as zero competitors");
  eq(removed.length, 1, "the tab is closed regardless");
}

{
  const { opened } = makeChrome([reply(1), reply(1), reply(1)]);
  const many = Array.from({ length: 20 }, (_, i) => `term ${i}`);
  const hits = await sweep(many, fast);
  eq(hits.length, MAX_TERMS, `no more than ${MAX_TERMS} searches, whatever is asked for`);
  eq(opened.length, MAX_TERMS, "and no more than that many tabs");
}
delete globalThis.chrome;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
