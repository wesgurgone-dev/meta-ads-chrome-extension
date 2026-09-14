/**
 * Unit tests for dashboard/metrics.js - the range parsing and aggregation
 * behind the metrics panel. Run: node tests/metrics.test.cjs
 *
 * These cover the formats Meta actually emits for spend and impressions,
 * including the awkward ones (open-ended "10M+", upper-bound-only "<1K") and
 * the rules that keep totals honest: per-currency grouping, coverage counts,
 * and never inventing a ceiling for an open-ended total.
 */
const fs = require("fs");
const path = require("path");

// The repo's package.json sets "type":"module", so compile the extension's
// classic script the way Chrome loads it (a plain script, not an ES module).
const loadScript = (p) => {
  const m = new module.constructor();
  m._compile(fs.readFileSync(p, "utf8"), p);
  return m.exports;
};
const M = loadScript(path.join(__dirname, "../dashboard/metrics.js"));

let fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`);
    fail++;
  } else {
    console.log(`ok   ${name}`);
  }
};

// --- range text parsing (the shapes Meta actually renders) ----------------
eq('range "1K - 5K"', M.parseRangeText("1K - 5K"), {
  lower: 1000,
  upper: 5000,
});
eq('range "1,000 - 5,000"', M.parseRangeText("1,000 - 5,000"), {
  lower: 1000,
  upper: 5000,
});
eq('range "100 - 199"', M.parseRangeText("100 - 199"), {
  lower: 100,
  upper: 199,
});
eq('range "$0 - $99"', M.parseRangeText("$0 - $99"), { lower: 0, upper: 99 });
eq('range "≤1000"', M.parseRangeText("≤1000"), { lower: 0, upper: 1000 });
eq('range "<1K"', M.parseRangeText("<1K"), { lower: 0, upper: 1000 });
eq('range "10M+"', M.parseRangeText("10M+"), { lower: 10000000, upper: null });
eq('range "≥5K"', M.parseRangeText("≥5K"), { lower: 5000, upper: null });
eq('range exact "750"', M.parseRangeText("750"), { lower: 750, upper: 750 });
eq('range en-dash "1.5M – 2M"', M.parseRangeText("1.5M – 2M"), {
  lower: 1500000,
  upper: 2000000,
});
eq("range null", M.parseRangeText(null), null);
eq("range junk", M.parseRangeText("n/a"), null);

// --- summing, incl. open-ended contributors -------------------------------
eq(
  "sum closed",
  M.sumRanges([
    { lower: 100, upper: 199 },
    { lower: 200, upper: 299 },
  ]),
  { lower: 300, upper: 498, openEnded: false, count: 2 },
);
eq(
  "sum open-ended has no ceiling",
  M.sumRanges([
    { lower: 100, upper: 199 },
    { lower: 1000, upper: null },
  ]),
  { lower: 1100, upper: null, openEnded: true, count: 2 },
);
eq("sum none", M.sumRanges([null, null]), null);

// --- captured numeric bounds win over the display string ------------------
eq(
  "bounds preferred",
  M.adSpendRange({ spendLower: 50, spendUpper: 99, spend: "999 - 999" }),
  {
    lower: 50,
    upper: 99,
  },
);
eq("text fallback", M.adSpendRange({ spend: "100 - 199" }), {
  lower: 100,
  upper: 199,
});

// --- aggregate ------------------------------------------------------------
const now = new Date("2026-05-10T12:00:00Z").getTime();
const day = 86400000;
const ads = [
  {
    id: "1",
    pageName: "Acme",
    pageId: "a",
    isActive: true,
    savedAt: now - 2 * day,
    startDate: now - 60 * day,
    media: [{ type: "video" }],
    platforms: ["FACEBOOK", "INSTAGRAM"],
    spend: "100 - 199",
    currency: "USD",
    impressionsText: "1K - 5K",
    euTotalReach: 4000,
  },
  {
    id: "2",
    pageName: "Acme",
    pageId: "a",
    isActive: false,
    endDate: now - 10 * day,
    savedAt: now - 1 * day,
    startDate: now - 20 * day,
    media: [{ type: "image" }, { type: "image" }],
    platforms: ["FACEBOOK"],
    spend: "200 - 299",
    currency: "USD",
    impressionsText: "10M+",
  },
  {
    id: "3",
    pageName: "Globex",
    pageId: "g",
    isActive: true,
    savedAt: now,
    startDate: now - 5 * day,
    media: [{ type: "image" }],
    platforms: ["INSTAGRAM"],
    spend: "50 - 99",
    currency: "EUR",
    euTotalReach: 1500,
  },
  {
    id: "4",
    pageName: "Initech",
    pageId: "i",
    isActive: null,
    savedAt: now - 45 * day,
    startDate: now - 90 * day,
    media: [],
    platforms: [],
  },
];
const agg = M.aggregate(ads, { now });
eq("total", agg.total, 4);
eq("advertisers", agg.advertiserCount, 3);
eq("active", agg.active, 2);
eq("long runners (>=30d)", agg.longRunners, 2);
eq(
  "spend split by currency",
  agg.spend.map((s) => s.currency),
  ["USD", "EUR"],
);
eq(
  "usd spend total",
  { l: agg.spend[0].lower, u: agg.spend[0].upper, n: agg.spend[0].count },
  { l: 300, u: 498, n: 2 },
);
eq(
  "eur spend total",
  { l: agg.spend[1].lower, u: agg.spend[1].upper },
  { l: 50, u: 99 },
);
eq("impressions open-ended", agg.impressions.openEnded, true);
eq("impressions upper null when open", agg.impressions.upper, null);
eq("impressions lower", agg.impressions.lower, 1000 + 10000000);
eq("eu reach", { r: agg.euReach, n: agg.euReachCount }, { r: 5500, n: 2 });
eq("saves today", agg.saves.today, 1);
eq("saves week", agg.saves.week, 3);
eq("saves month", agg.saves.month, 3);
eq("timeline length", agg.saves.timeline.length, 30);
eq("timeline last day value", agg.saves.timeline[29].value, 1);
eq(
  "timeline sum",
  agg.saves.timeline.reduce((s, d) => s + d.value, 0),
  3,
);
eq("format counts", agg.formatCounts, {
  video: 1,
  image: 1,
  carousel: 1,
  text: 1,
});
eq("top advertiser", agg.advertisers.rows[0], { label: "Acme", value: 2 });
eq("platform top", agg.platformCounts.rows[0], { label: "facebook", value: 2 });

// --- tail folding ---------------------------------------------------------
const many = M.topCounts(["a", "a", "b", "c", "d", "e", "f", "g", "h", "i"], 3);
eq(
  "topCounts head",
  many.rows.map((r) => r.label),
  ["a", "b", "c"],
);
eq(
  "topCounts other",
  { c: many.otherCount, v: many.otherValue },
  { c: 6, v: 6 },
);

// --- formatting -----------------------------------------------------------
eq("compact 1284", M.compact(1284), "1,284");
eq("compact 12900", M.compact(12900), "13K");
eq("compact 4.2M", M.compact(4200000), "4.2M");
eq(
  "formatRange",
  M.formatRange({ lower: 300, upper: 498, openEnded: false, count: 2 }, "$"),
  "$300 – $498",
);
eq(
  "formatRange open-ended reads as at-least",
  M.formatRange({ lower: 1000, upper: null, openEnded: true, count: 1 }, ""),
  "1,000+",
);
eq(
  "formatRange open-ended ignores stale upper",
  M.formatRange(
    { lower: 30006000, upper: 30006000, openEnded: true, count: 9 },
    "",
  ),
  "30M+",
);
eq(
  "formatRange exact",
  M.formatRange({ lower: 500, upper: 500, openEnded: false, count: 1 }, "$"),
  "$500",
);
eq("formatRange empty", M.formatRange(null), "-");

console.log(fail === 0 ? "\nALL METRICS TESTS PASS" : `\n${fail} FAILURES`);
process.exit(fail ? 1 : 0);
