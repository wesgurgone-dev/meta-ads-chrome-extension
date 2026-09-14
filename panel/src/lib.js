/** Messaging and derived data. No React in here, so it stays easy to reason about. */

export const send = (msg) =>
  new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError)
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(res || { ok: false });
      });
    } catch (err) {
      resolve({ ok: false, error: String(err && err.message) });
    }
  });

/**
 * Ask the active tab what it is showing. A tab without the content script
 * rejects, and that is the normal case off the Ad Library, not an error.
 */
export const askPage = async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return { ads: [], onLibrary: false };
    const res = await chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_ADS" });
    return res && res.ok ? res : { ads: [], onLibrary: false };
  } catch (err) {
    return { ads: [], onLibrary: false };
  }
};

export const daysRunning = (ad) => {
  if (!ad.startDate) return null;
  const end = ad.isActive === false && ad.endDate ? ad.endDate : Date.now();
  return Math.max(1, Math.round((end - ad.startDate) / 86400000));
};

export const formatOf = (ad) => {
  const kinds = (ad.media || []).length
    ? ad.media.map((m) => m.type)
    : ad.mediaKinds || [];
  if (kinds.filter((k) => k !== "video").length > 1) return "carousel";
  if (kinds.some((k) => k === "video")) return "video";
  if (kinds.length) return "image";
  return "text";
};

export const thumbOf = (ad) => {
  if (ad.thumbDataUrl) return ad.thumbDataUrl;
  const m = (ad.media || []).find((x) => x.previewUrl) || (ad.media || [])[0];
  return (m && (m.previewUrl || (m.type === "image" ? m.url : null))) || null;
};

export const savedInSpace = (store) => {
  const ids = new Set();
  for (const l of Object.values(store.lists || {})) {
    if (l.spaceId !== (store.settings || {}).activeSpaceId) continue;
    for (const id of l.adIds) ids.add(id);
  }
  return [...ids]
    .map((id) => (store.ads || {})[id])
    .filter(Boolean)
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
};

export const listsForAd = (store, id) =>
  Object.values(store.lists || {}).filter(
    (l) =>
      l.spaceId === (store.settings || {}).activeSpaceId &&
      (l.adIds || []).includes(id),
  );

export const openInLibrary = (ad) => {
  if (ad.libraryUrl) chrome.tabs.create({ url: ad.libraryUrl });
};
