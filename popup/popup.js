(() => {
  "use strict";

  const M = globalThis.MalMetrics;

  chrome.runtime.sendMessage({ type: "GET_STATE" }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok) return;
    const ads = Object.values(res.ads || {});
    const lists = Object.values(res.lists || {});
    const agg = M.aggregate(ads);
    const topSpend = agg.spend[0] || null;

    document.getElementById("summary").textContent =
      ads.length === 0 ? "Nothing saved yet" : `${ads.length} ads saved`;

    const tiles = [
      { label: "Saved ads", value: M.compact(agg.total) },
      { label: "Saved this week", value: M.compact(agg.saves.week) },
      { label: "Advertisers", value: M.compact(agg.advertiserCount) },
      { label: "Active now", value: M.compact(agg.active) },
      {
        label: topSpend ? `Spend (${topSpend.currency})` : "Spend",
        value: topSpend ? M.formatRange(topSpend, "") : "-",
        note: topSpend
          ? `${topSpend.count} of ${agg.total} ads`
          : "not disclosed",
      },
      {
        label: "Impressions",
        value: agg.impressions ? M.formatRange(agg.impressions, "") : "-",
        note: agg.impressions
          ? `${agg.impressions.count} of ${agg.total} ads`
          : "not disclosed",
      },
      { label: "Lists", value: M.compact(lists.length) },
      {
        label: "EU reach",
        value: agg.euReach ? M.compact(agg.euReach) : "-",
        note: agg.euReachCount ? `${agg.euReachCount} ads` : "EU ads only",
      },
    ];

    const esc = (s) =>
      String(s ?? "").replace(
        /[&<>"']/g,
        (c) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[c],
      );

    document.getElementById("stats").innerHTML = tiles
      .map(
        (s) => `<div class="stat">
          <div class="stat-value">${esc(s.value)}</div>
          <div class="stat-label">${esc(s.label)}</div>
          ${s.note ? `<div class="stat-note">${esc(s.note)}</div>` : ""}
        </div>`,
      )
      .join("");
  });

  document.getElementById("open-dashboard").addEventListener("click", () => {
    chrome.tabs.create({
      url: chrome.runtime.getURL("dashboard/dashboard.html"),
    });
  });

  document.getElementById("open-library").addEventListener("click", () => {
    chrome.tabs.create({ url: "https://www.facebook.com/ads/library/" });
  });
})();
