/**
 * Dashboard data layer. Pure functions and messaging, no React, so the parts
 * that decide what is shown stay testable on their own.
 */
// metrics.js supports both worlds: it sets module.exports when there is one
// and globalThis.MalMetrics otherwise. The bundler sees the module.exports
// branch and takes it, so import the value rather than expecting the global.
import metricsModule from "../metrics.js";

export const M = metricsModule || globalThis.MalMetrics;

/** The eight label colours, in the order the picker shows them. */
export const LIST_COLORS = [
  "#2a78d6",
  "#eb6834",
  "#1baf7a",
  "#eda100",
  "#e87ba4",
  "#008300",
  "#4a3aa7",
  "#e34948",
];

export const send = (msg) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError)
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res || { ok: false });
    });
  });

export const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString() : "-");
export const fmtNum = (n) => (n == null ? "-" : Number(n).toLocaleString());
export const daysRunning = (ad) => M.daysRunning(ad);
export const adFormat = (ad) => M.adFormat(ad);

export const thumbFor = (ad) => {
  if (ad.thumbDataUrl) return ad.thumbDataUrl;
  const m = (ad.media || []).find((x) => x.previewUrl) || (ad.media || [])[0];
  return (m && (m.previewUrl || (m.type === "image" ? m.url : null))) || null;
};

export const spaceLists = (state) =>
  Object.values(state.lists)
    .filter((l) => l.spaceId === state.settings.activeSpaceId)
    .sort((a, b) => a.createdAt - b.createdAt);

export const listsForAd = (state, adId) =>
  spaceLists(state).filter((l) => (l.adIds || []).includes(adId));

/** Filter and sort exactly as the imperative dashboard did. */
export const visibleAds = (state, ui) => {
  const lists = spaceLists(state);
  let ids;
  if (ui.activeList === "__all__") {
    ids = new Set();
    for (const l of lists) for (const id of l.adIds) ids.add(id);
  } else {
    ids = new Set((state.lists[ui.activeList] || { adIds: [] }).adIds);
  }

  let ads = [...ids].map((id) => state.ads[id]).filter(Boolean);

  if (ui.format) ads = ads.filter((ad) => adFormat(ad) === ui.format);
  if (ui.status === "active") ads = ads.filter((ad) => ad.isActive === true);
  if (ui.status === "inactive") ads = ads.filter((ad) => ad.isActive === false);
  if (ui.search) {
    const q = ui.search.toLowerCase();
    ads = ads.filter((ad) =>
      [ad.pageName, ad.body, ad.title, ad.ctaText, ad.linkUrl, ad.savedBy, ad.id]
        .filter(Boolean)
        .some((f) => String(f).toLowerCase().includes(q)),
    );
  }

  const sorters = {
    saved: (a, b) => (b.savedAt || 0) - (a.savedAt || 0),
    running: (a, b) => (daysRunning(b) || 0) - (daysRunning(a) || 0),
    started: (a, b) => (b.startDate || 0) - (a.startDate || 0),
    advertiser: (a, b) =>
      String(a.pageName || "").localeCompare(String(b.pageName || "")),
  };
  return ads.sort(sorters[ui.sort] || sorters.saved);
};

export const downloadBlob = (content, filename, mime) => {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};

export const exportJson = (ads) =>
  downloadBlob(
    JSON.stringify(ads, null, 2),
    `meta-ads-${Date.now()}.json`,
    "application/json",
  );

export const exportCsv = (state, ads) => {
  const cols = [
    "id", "pageName", "isActive", "startDate", "endDate", "daysRunning",
    "platforms", "format", "lists", "savedBy", "savedAt", "title", "body",
    "ctaText", "linkUrl", "libraryUrl",
  ];
  const cell = (v) =>
    `"${String(v ?? "").replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
  const lines = [cols.join(",")];
  for (const ad of ads) {
    lines.push(
      cols
        .map((c) => {
          if (c === "daysRunning") return cell(daysRunning(ad));
          if (c === "format") return cell(adFormat(ad));
          if (c === "platforms") return cell((ad.platforms || []).join("|"));
          if (c === "lists")
            return cell(listsForAd(state, ad.id).map((l) => l.name).join("|"));
          if (c === "savedAt")
            return cell(ad[c] ? new Date(ad[c]).toISOString() : "");
          if (c === "startDate" || c === "endDate")
            return cell(ad[c] ? new Date(ad[c]).toISOString().slice(0, 10) : "");
          return cell(ad[c]);
        })
        .join(","),
    );
  }
  downloadBlob(lines.join("\n"), `meta-ads-${Date.now()}.csv`, "text/csv");
};
