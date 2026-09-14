(() => {
  "use strict";

  chrome.runtime.sendMessage({ type: "GET_STATE" }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok) return;
    const ads = Object.values(res.ads || {});
    const lists = Object.values(res.lists || {});
    const active = ads.filter((a) => a.isActive === true).length;
    const advertisers = new Set(ads.map((a) => a.pageId || a.pageName)).size;
    document.getElementById("summary").textContent =
      ads.length === 0 ? "Nothing saved yet" : `${ads.length} ads saved`;
    document.getElementById("stats").innerHTML = [
      { label: "Saved ads", value: ads.length },
      { label: "Lists", value: lists.length },
      { label: "Active now", value: active },
      { label: "Advertisers", value: advertisers },
    ]
      .map(
        (s) => `<div class="stat"><div class="stat-value">${s.value}</div>
                <div class="stat-label">${s.label}</div></div>`,
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
