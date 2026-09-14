/**
 * Isolated-world content script for facebook.com/ads/library.
 *
 * Receives normalized ads from the MAIN-world interceptor, keeps them in an
 * in-memory map, decorates each visible ad card with Save / Download buttons
 * (matched by the "Library ID" shown on every card), and renders a floating
 * panel with page-level actions.
 */
(() => {
  "use strict";

  const MSG_TYPE = "MAL_ADS_CAPTURED";
  const captured = new Map(); // adId -> normalized ad
  const savedIds = new Set(); // ids already in the extension library
  let panelCountEl = null;

  // ---------------------------------------------------------------------
  // Capture channel
  // ---------------------------------------------------------------------

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.type !== MSG_TYPE || !Array.isArray(data.ads)) return;
    for (const ad of data.ads) {
      if (ad && ad.id) captured.set(ad.id, ad);
    }
    updatePanel();
    decorateCards();
  });

  chrome.runtime.sendMessage({ type: "GET_SAVED_IDS" }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    for (const id of res.ids || []) savedIds.add(id);
    decorateCards(true);
  });

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  const toast = (message) => {
    let el = document.getElementById("mal-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "mal-toast";
      document.documentElement.appendChild(el);
    }
    el.textContent = message;
    el.classList.add("mal-toast-visible");
    clearTimeout(el.__malTimer);
    el.__malTimer = setTimeout(
      () => el.classList.remove("mal-toast-visible"),
      2200,
    );
  };

  const saveAds = (ads, onDone) => {
    chrome.runtime.sendMessage({ type: "SAVE_ADS", ads }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok) {
        toast("Save failed - is the extension enabled?");
        return;
      }
      for (const ad of ads) savedIds.add(ad.id);
      toast(
        res.added === 0
          ? "Already in your library"
          : `Saved ${res.added} ad${res.added === 1 ? "" : "s"}`,
      );
      decorateCards(true);
      if (onDone) onDone();
    });
  };

  const downloadAd = (ad) => {
    if (!ad.media || ad.media.length === 0) {
      toast("No downloadable media captured for this ad");
      return;
    }
    chrome.runtime.sendMessage({ type: "DOWNLOAD_AD", ad }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok) {
        toast("Download failed");
        return;
      }
      toast(`Downloading ${res.count} file${res.count === 1 ? "" : "s"}`);
    });
  };

  // ---------------------------------------------------------------------
  // Per-card decoration
  // ---------------------------------------------------------------------

  // Card text contains "Library ID: 1234567890123456" in every locale the ID
  // itself is stable, so match long digit runs and check them against the
  // captured set.
  const ID_RE = /\b(\d{12,20})\b/g;

  const findCardContainer = (el) => {
    // Walk up from the "Library ID" text until the container also holds the
    // ad creative (img/video). Cap the walk so we never grab the whole feed.
    let node = el;
    for (let i = 0; i < 12 && node && node !== document.body; i++) {
      if (node.querySelector && node.querySelector("img, video")) return node;
      node = node.parentElement;
    }
    return null;
  };

  const buildToolbar = (ad) => {
    const bar = document.createElement("div");
    bar.className = "mal-toolbar";
    bar.dataset.malAdId = ad.id;

    const saveBtn = document.createElement("button");
    saveBtn.className = "mal-btn mal-btn-save";
    saveBtn.type = "button";
    saveBtn.textContent = savedIds.has(ad.id) ? "Saved ✓" : "Save";
    saveBtn.disabled = savedIds.has(ad.id);
    saveBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      saveAds([ad]);
    });

    const dlBtn = document.createElement("button");
    dlBtn.className = "mal-btn mal-btn-dl";
    dlBtn.type = "button";
    dlBtn.textContent = "Download";
    dlBtn.title = "Download creative files";
    dlBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      downloadAd(ad);
    });

    bar.append(saveBtn, dlBtn);
    return bar;
  };

  const decorateCards = (refreshExisting = false) => {
    if (captured.size === 0) return;

    if (refreshExisting) {
      for (const bar of document.querySelectorAll(".mal-toolbar")) {
        const id = bar.dataset.malAdId;
        const btn = bar.querySelector(".mal-btn-save");
        if (btn && savedIds.has(id)) {
          btn.textContent = "Saved ✓";
          btn.disabled = true;
        }
      }
    }

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) =>
          node.nodeValue && /\d{12}/.test(node.nodeValue)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT,
      },
    );

    const matches = [];
    let textNode;
    while ((textNode = walker.nextNode())) {
      ID_RE.lastIndex = 0;
      let m;
      while ((m = ID_RE.exec(textNode.nodeValue))) {
        if (captured.has(m[1])) {
          matches.push({ id: m[1], node: textNode });
          break;
        }
      }
    }

    for (const { id, node } of matches) {
      const container = findCardContainer(node.parentElement);
      if (
        !container ||
        container.querySelector(":scope > .mal-toolbar, .mal-toolbar")
      )
        continue;
      const ad = captured.get(id);
      container.style.position = container.style.position || "relative";
      container.prepend(buildToolbar(ad));
    }
  };

  const observer = new MutationObserver(() => {
    clearTimeout(observer.__malTimer);
    observer.__malTimer = setTimeout(() => decorateCards(), 400);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // ---------------------------------------------------------------------
  // Floating panel
  // ---------------------------------------------------------------------

  const buildPanel = () => {
    const panel = document.createElement("div");
    panel.id = "mal-panel";
    panel.innerHTML = `
      <div class="mal-panel-header">
        <span class="mal-panel-logo">▲</span>
        <span class="mal-panel-title">Ads Saver</span>
        <span id="mal-panel-count" class="mal-panel-count">0</span>
      </div>
      <div class="mal-panel-actions">
        <button type="button" id="mal-save-all" class="mal-btn mal-btn-save">Save all captured</button>
        <button type="button" id="mal-open-dash" class="mal-btn mal-btn-dl">Open dashboard</button>
      </div>
      <div class="mal-panel-hint">Scroll the results to capture more ads.</div>
    `;
    document.documentElement.appendChild(panel);

    panel.querySelector("#mal-save-all").addEventListener("click", () => {
      const ads = [...captured.values()];
      if (ads.length === 0) {
        toast("Nothing captured yet - scroll the results first");
        return;
      }
      saveAds(ads);
    });
    panel.querySelector("#mal-open-dash").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD" });
    });

    panelCountEl = panel.querySelector("#mal-panel-count");
    return panel;
  };

  const updatePanel = () => {
    if (!panelCountEl) buildPanel();
    if (panelCountEl) panelCountEl.textContent = String(captured.size);
  };

  if (document.body) updatePanel();
  else
    document.addEventListener("DOMContentLoaded", updatePanel, { once: true });
})();
