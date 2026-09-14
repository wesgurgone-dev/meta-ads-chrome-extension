/**
 * Unit tests for dashboard/metrics.js.
 *
 * Spend and impressions aggregation was removed deliberately: Meta publishes
 * those only for political and social-issue ads, so they were empty for
 * essentially every real commercial search. What remains is exact.
 *
 * Run: node tests/metrics.test.cjs
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

const now = new Date("2026-05-10T12:00:00Z").getTime();
const day = 86400000;

// --- format detection -----------------------------------------------------
eq("format video", M.adFormat({ media: [{ type: "video" }] }), "video");
eq("format image", M.adFormat({ media: [{ type: "image" }] }), "image");
eq(
  "format carousel by count",
  M.adFormat({ media: [{ type: "image" }, { type: "image" }] }),
  "carousel",
);
eq(
  "format carousel by flag",
  M.adFormat({ media: [{ type: "image" }], displayFormat: "CAROUSEL" }),
  "carousel",
);
eq("format text", M.adFormat({ media: [] }), "text");
// A synced ad carries mediaKinds instead of media, and must still classify.
eq(
  "format from synced mediaKinds",
  M.adFormat({ media: [], mediaKinds: ["video"] }),
  "video",
);

// --- longevity ------------------------------------------------------------
eq(
  "days running, active counts to today",
  M.daysRunning({ startDate: now - 10 * day, isActive: true }, now),
  10,
);
eq(
  "days running, ended stops at end",
  M.daysRunning(
    { startDate: now - 30 * day, endDate: now - 20 * day, isActive: false },
    now,
  ),
  10,
);
eq("days running, no start", M.daysRunning({}, now), null);
eq(
  "days running, floor of 1",
  M.daysRunning({ startDate: now - 1000, isActive: true }, now),
  1,
);

// --- aggregate ------------------------------------------------------------
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
    savedBy: "Wes",
  },
  {
    id: "2",
    pageName: "Acme",
    pageId: "a",
    isActive: false,
    endDate: now - 10 * day,
    savedAt: now - day,
    startDate: now - 20 * day,
    media: [{ type: "image" }, { type: "image" }],
    platforms: ["FACEBOOK"],
    savedBy: "Wes",
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
    savedBy: "Sam",
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
eq("avg days running", agg.avgDaysRunning, Math.round((60 + 10 + 5 + 90) / 4));
eq("max days running", agg.maxDaysRunning, 90);
eq("saves today", agg.saves.today, 1);
eq("saves week", agg.saves.week, 3);
eq("saves month", agg.saves.month, 3);
eq("timeline length", agg.saves.timeline.length, 30);
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
eq("contributors", agg.contributors.rows, [
  { label: "Wes", value: 2 },
  { label: "Sam", value: 1 },
]);

// Empty library must not throw or produce NaN.
const empty = M.aggregate([], { now });
eq("empty total", empty.total, 0);
eq("empty avg days", empty.avgDaysRunning, null);
eq("empty timeline", empty.saves.timeline.length, 30);
eq("empty contributors", empty.contributors.rows, []);

// --- no spend/impressions surface remains ---------------------------------
eq("spend helpers removed", typeof M.adSpendRange, "undefined");
eq("range parser removed", typeof M.parseRangeText, "undefined");
eq("aggregate exposes no spend", agg.spend, undefined);
eq("aggregate exposes no impressions", agg.impressions, undefined);

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
eq("compact null", M.compact(null), "-");

console.log(fail === 0 ? "\nALL METRICS TESTS PASS" : `\n${fail} FAILURES`);
process.exit(fail ? 1 : 0);
