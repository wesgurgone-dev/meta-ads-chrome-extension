/**
 * Metric parsing and aggregation for saved Meta ads.
 *
 * Meta publishes spend and impressions as *ranges*, never exact figures, and
 * only for ads it is legally required to disclose (political / social-issue
 * ads, plus EU reach under the DSA). Everything here therefore aggregates
 * bounds into a total range and reports how many ads the range covers, so a
 * total is never mistaken for a precise number.
 *
 * Loaded as a classic script in the dashboard (exposes window.MalMetrics) and
 * requirable in Node for tests.
 */
(function (root) {
  "use strict";

  const SUFFIX = { k: 1e3, m: 1e6, b: 1e9 };

  /** Parse a single quantity: "1,200", "5K", "1.2M", "$99". */
  const parseQuantity = (raw) => {
    if (raw == null) return null;
    if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
    const cleaned = String(raw)
      .replace(/[,\s]/g, "")
      .replace(/^[^\d<>≤≥.+-]*/, "");
    const m = cleaned.match(/^(\d+(?:\.\d+)?)([kmb])?/i);
    if (!m) return null;
    const n = Number(m[1]) * (SUFFIX[(m[2] || "").toLowerCase()] || 1);
    return Number.isFinite(n) ? n : null;
  };

  /**
   * Parse a range as Meta renders it.
   * Returns { lower, upper } where upper === null means open-ended ("10M+").
   */
  const parseRangeText = (raw) => {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s) return null;

    // "≤1000" / "<1K" - an upper bound with an implicit floor of zero.
    if (/^[<≤]/.test(s)) {
      const upper = parseQuantity(s.replace(/^[<≤]\s*/, ""));
      return upper == null ? null : { lower: 0, upper };
    }

    // "10M+" / "≥10M" - a floor with no ceiling.
    if (/\+\s*$/.test(s) || /^[>≥]/.test(s)) {
      const lower = parseQuantity(
        s.replace(/^[>≥]\s*/, "").replace(/\+\s*$/, ""),
      );
      return lower == null ? null : { lower, upper: null };
    }

    // "1K - 5K" / "100 – 199". Split only on a dash that separates tokens, so
    // a negative or hyphenated value is not torn in half.
    const parts = s.split(/\s+[–—-]\s+|(?<=[\dKMBkmb])\s*[–—]\s*(?=[$€£₹\d])/);
    if (parts.length >= 2) {
      const lower = parseQuantity(parts[0]);
      const upper = parseQuantity(parts[parts.length - 1]);
      if (lower != null && upper != null) return { lower, upper };
    }

    const exact = parseQuantity(s);
    return exact == null ? null : { lower: exact, upper: exact };
  };

  /** Spend range for one ad, preferring captured numeric bounds. */
  const adSpendRange = (ad) => {
    if (ad.spendLower != null || ad.spendUpper != null) {
      return { lower: ad.spendLower ?? 0, upper: ad.spendUpper ?? null };
    }
    return parseRangeText(ad.spend);
  };

  /** Impressions range for one ad, preferring captured numeric bounds. */
  const adImpressionsRange = (ad) => {
    if (ad.impressionsLower != null || ad.impressionsUpper != null) {
      return {
        lower: ad.impressionsLower ?? 0,
        upper: ad.impressionsUpper ?? null,
      };
    }
    return parseRangeText(ad.impressionsText);
  };

  /**
   * Sum ranges into a total range.
   *
   * If any contributor is open-ended ("10M+") the total has no knowable
   * ceiling, so `upper` is null rather than a partial sum - reporting the sum
   * of only the bounded ads as the maximum would understate the total and read
   * as a real ceiling.
   */
  const sumRanges = (ranges) => {
    let lower = 0;
    let upper = 0;
    let openEnded = false;
    let count = 0;
    for (const r of ranges) {
      if (!r) continue;
      count += 1;
      lower += r.lower || 0;
      if (r.upper == null) openEnded = true;
      else upper += r.upper;
    }
    if (count === 0) return null;
    return {
      lower,
      upper: openEnded ? null : Math.max(upper, lower),
      openEnded,
      count,
    };
  };

  const dayKey = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const startOfDay = (ms) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };

  const adFormat = (ad) => {
    const media = ad.media || [];
    if (
      media.filter((m) => m.type !== "video").length > 1 ||
      ad.displayFormat === "CAROUSEL"
    )
      return "carousel";
    if (media.some((m) => m.type === "video")) return "video";
    if (media.length > 0) return "image";
    return "text";
  };

  const daysRunning = (ad, now = Date.now()) => {
    if (!ad.startDate) return null;
    const end = ad.isActive === false && ad.endDate ? ad.endDate : now;
    return Math.max(1, Math.round((end - ad.startDate) / 86400000));
  };

  /** Count occurrences, returning the top N plus an "Other" remainder. */
  const topCounts = (items, limit) => {
    const counts = new Map();
    for (const item of items) {
      if (item == null || item === "") continue;
      counts.set(item, (counts.get(item) || 0) + 1);
    }
    const sorted = [...counts.entries()]
      .map(([label, value]) => ({ label, value }))
      .sort(
        (a, b) =>
          b.value - a.value || String(a.label).localeCompare(String(b.label)),
      );
    if (sorted.length <= limit)
      return { rows: sorted, otherCount: 0, otherValue: 0 };
    const head = sorted.slice(0, limit);
    const tail = sorted.slice(limit);
    return {
      rows: head,
      otherCount: tail.length,
      otherValue: tail.reduce((s, r) => s + r.value, 0),
    };
  };

  /**
   * Everything the metrics panel needs, computed from the ads currently in
   * view plus the whole library (for save-activity totals).
   */
  const aggregate = (ads, options) => {
    const opts = options || {};
    const now = opts.now || Date.now();
    const timelineDays = opts.timelineDays || 30;

    // --- Spend, grouped by currency: summing USD and EUR would be nonsense.
    const spendByCurrency = new Map();
    for (const ad of ads) {
      const range = adSpendRange(ad);
      if (!range) continue;
      const cur = ad.currency || "Unknown";
      if (!spendByCurrency.has(cur)) spendByCurrency.set(cur, []);
      spendByCurrency.get(cur).push(range);
    }
    const spend = [...spendByCurrency.entries()]
      .map(([currency, ranges]) => ({ currency, ...sumRanges(ranges) }))
      .sort((a, b) => b.lower - a.lower);

    // --- Impressions.
    const impressions = sumRanges(ads.map(adImpressionsRange));

    // --- EU reach is an exact figure where Meta publishes it at all.
    let euReach = 0;
    let euReachCount = 0;
    for (const ad of ads) {
      if (typeof ad.euTotalReach === "number" && ad.euTotalReach > 0) {
        euReach += ad.euTotalReach;
        euReachCount += 1;
      }
    }

    // --- Save activity (our own data, always exact).
    const todayStart = startOfDay(now);
    const savedToday = ads.filter((a) => (a.savedAt || 0) >= todayStart).length;
    const savedWeek = ads.filter(
      (a) => (a.savedAt || 0) >= now - 7 * 86400000,
    ).length;
    const savedMonth = ads.filter(
      (a) => (a.savedAt || 0) >= now - 30 * 86400000,
    ).length;

    const byDay = new Map();
    for (const ad of ads) {
      if (!ad.savedAt) continue;
      const key = dayKey(ad.savedAt);
      byDay.set(key, (byDay.get(key) || 0) + 1);
    }
    const timeline = [];
    for (let i = timelineDays - 1; i >= 0; i--) {
      const ms = todayStart - i * 86400000;
      const key = dayKey(ms);
      timeline.push({ key, ms, value: byDay.get(key) || 0 });
    }

    // --- Breakdowns.
    const advertisers = topCounts(
      ads.map((a) => a.pageName).filter(Boolean),
      8,
    );
    const formatCounts = { video: 0, image: 0, carousel: 0, text: 0 };
    for (const ad of ads) formatCounts[adFormat(ad)] += 1;

    const platformCounts = topCounts(
      ads.flatMap((a) =>
        (a.platforms || []).map((p) => String(p).toLowerCase()),
      ),
      6,
    );

    const runs = ads.map((a) => daysRunning(a, now)).filter((d) => d != null);
    const longRunners = ads.filter(
      (a) => (daysRunning(a, now) || 0) >= 30,
    ).length;

    return {
      total: ads.length,
      advertiserCount: new Set(ads.map((a) => a.pageId || a.pageName)).size,
      active: ads.filter((a) => a.isActive === true).length,
      withMedia: ads.filter((a) => (a.media || []).length > 0).length,
      avgDaysRunning: runs.length
        ? Math.round(runs.reduce((s, d) => s + d, 0) / runs.length)
        : null,
      maxDaysRunning: runs.length ? Math.max(...runs) : null,
      longRunners,
      spend,
      impressions,
      euReach,
      euReachCount,
      saves: {
        today: savedToday,
        week: savedWeek,
        month: savedMonth,
        timeline,
      },
      advertisers,
      formatCounts,
      platformCounts,
    };
  };

  // --- Formatting -------------------------------------------------------

  /** Compact figure for stat tiles: 1,284 / 12.9K / 4.2M. */
  const compact = (n) => {
    if (n == null || !Number.isFinite(n)) return "-";
    const abs = Math.abs(n);
    if (abs >= 1e9) return `${(n / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
    if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
    if (abs >= 1e4) return `${(n / 1e3).toFixed(0)}K`;
    return Math.round(n).toLocaleString();
  };

  /**
   * Render a summed range the way it should be read. An open-ended total
   * (upper unknown) reads as "at least X" - never as a range with an invented
   * ceiling.
   */
  const formatRange = (range, prefix) => {
    if (!range || range.count === 0) return "-";
    const p = prefix || "";
    if (range.upper == null || range.openEnded)
      return `${p}${compact(range.lower)}+`;
    if (range.lower === range.upper) return `${p}${compact(range.lower)}`;
    return `${p}${compact(range.lower)} – ${p}${compact(range.upper)}`;
  };

  const api = {
    parseQuantity,
    parseRangeText,
    adSpendRange,
    adImpressionsRange,
    sumRanges,
    aggregate,
    adFormat,
    daysRunning,
    topCounts,
    compact,
    formatRange,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MalMetrics = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
