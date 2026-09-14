/**
 * Aggregation for the saved-ad library.
 *
 * Deliberately scoped to signals the Ad Library actually provides for ordinary
 * commercial ads. Spend and impressions are published only for political and
 * social-issue ads, so totals for them were empty for almost every real search
 * and have been dropped rather than shown as a permanent "not disclosed".
 *
 * What is left is exact: longevity, active state, creative format, placements,
 * and your own saving activity.
 *
 * Loaded as a classic script (exposes window.MalMetrics) and requirable in
 * Node for tests.
 */
(function (root) {
  "use strict";

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
    const kinds = media.length ? media.map((m) => m.type) : ad.mediaKinds || [];
    if (
      kinds.filter((k) => k !== "video").length > 1 ||
      ad.displayFormat === "CAROUSEL"
    )
      return "carousel";
    if (kinds.some((k) => k === "video")) return "video";
    if (kinds.length > 0) return "image";
    return "text";
  };

  /**
   * Days the ad has been live. For a still-active ad this counts to today,
   * which is the point: longevity is the public proxy for a winner, because
   * advertisers switch off creatives that stop paying.
   */
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

  const aggregate = (ads, options) => {
    const opts = options || {};
    const now = opts.now || Date.now();
    const timelineDays = opts.timelineDays || 30;

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
      timeline.push({ key: dayKey(ms), ms, value: byDay.get(dayKey(ms)) || 0 });
    }

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

    // Who saved what: only meaningful once a space is shared with a team.
    const contributors = topCounts(
      ads.map((a) => a.savedBy).filter(Boolean),
      6,
    );

    const runs = ads.map((a) => daysRunning(a, now)).filter((d) => d != null);

    return {
      total: ads.length,
      advertiserCount: new Set(ads.map((a) => a.pageId || a.pageName)).size,
      active: ads.filter((a) => a.isActive === true).length,
      avgDaysRunning: runs.length
        ? Math.round(runs.reduce((s, d) => s + d, 0) / runs.length)
        : null,
      maxDaysRunning: runs.length ? Math.max(...runs) : null,
      longRunners: ads.filter((a) => (daysRunning(a, now) || 0) >= 30).length,
      saves: {
        today: savedToday,
        week: savedWeek,
        month: savedMonth,
        timeline,
      },
      advertisers,
      formatCounts,
      platformCounts,
      contributors,
    };
  };

  /** Compact figure for stat tiles: 1,284 / 12.9K / 4.2M. */
  const compact = (n) => {
    if (n == null || !Number.isFinite(n)) return "-";
    const abs = Math.abs(n);
    if (abs >= 1e9) return `${(n / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
    if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
    if (abs >= 1e4) return `${(n / 1e3).toFixed(0)}K`;
    return Math.round(n).toLocaleString();
  };

  const api = { aggregate, adFormat, daysRunning, topCounts, compact };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MalMetrics = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
