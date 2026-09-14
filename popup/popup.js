(() => {
  "use strict";

  const M = globalThis.MalMetrics;

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

  chrome.runtime.sendMessage({ type: "GET_STATE" }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok) return;

    const spaces = res.spaces || {};
    const lists = Object.values(res.lists || {});
    const activeId = (res.settings || {}).activeSpaceId;
    const space = spaces[activeId];

    // Only the active space's ads: the popup should mirror the dashboard.
    const spaceListIds = lists.filter((l) => l.spaceId === activeId);
    const ids = new Set();
    for (const l of spaceListIds) for (const id of l.adIds) ids.add(id);
    const ads = [...ids].map((id) => (res.ads || {})[id]).filter(Boolean);
    const agg = M.aggregate(ads);

    document.getElementById("summary").textContent =
      ads.length === 0
        ? "Nothing saved yet"
        : `${ads.length} ads in this space`;

    document.getElementById("space").innerHTML = space
      ? space.kind === "team"
        ? `${esc(space.name)} · join code <span class="space-code">${esc(space.code)}</span>`
        : esc(space.name)
      : "No space";

    const tiles = [
      { label: "Ads saved", value: M.compact(agg.total) },
      { label: "Saved this week", value: M.compact(agg.saves.week) },
      { label: "Advertisers", value: M.compact(agg.advertiserCount) },
      { label: "Active now", value: M.compact(agg.active) },
      { label: "Running 30d+", value: M.compact(agg.longRunners) },
      { label: "Lists", value: M.compact(spaceListIds.length) },
    ];

    document.getElementById("stats").innerHTML = tiles
      .map(
        (s) => `<div class="stat">
          <div class="stat-value">${esc(s.value)}</div>
          <div class="stat-label">${esc(s.label)}</div>
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
