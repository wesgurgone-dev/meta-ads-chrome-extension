/**
 * Isolated-world content script for facebook.com/ads/library.
 *
 * Receives normalized ads from the MAIN-world interceptor, then decorates each
 * visible ad card with a Save split-button and a Download button. The controls
 * are inserted into the card's own button stack and styled to match Facebook's
 * UI rather than floating over the creative, so they read as part of the page.
 *
 * The Save button's caret opens a menu of spaces and colour-coded lists, so an
 * ad can go straight into the right place without opening the dashboard.
 */
(() => {
  "use strict";

  const MSG_TYPE = "MAL_ADS_CAPTURED";
  const captured = new Map(); // adId -> normalized ad
  const savedIds = new Set();
  let targets = { spaces: [], lists: [], activeSpaceId: null };
  let panelCountEl = null;
  let openMenu = null;

  // ---------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------

  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError)
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res || { ok: false });
        });
      } catch (err) {
        // The extension was reloaded out from under this page.
        resolve({ ok: false, error: "context_invalidated" });
      }
    });

  const refreshTargets = async () => {
    const res = await send({ type: "GET_SAVE_TARGETS" });
    if (!res.ok) return;
    targets = {
      spaces: res.spaces || [],
      lists: res.lists || [],
      activeSpaceId: res.activeSpaceId,
    };
    for (const id of res.savedIds || []) savedIds.add(id);
    refreshSavedButtons();
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.type !== MSG_TYPE || !Array.isArray(data.ads)) return;
    for (const ad of data.ads) if (ad && ad.id) captured.set(ad.id, ad);
    updatePanel();
    decorateCards();
  });

  // ---------------------------------------------------------------------
  // Toast
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
      2400,
    );
  };

  // ---------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------

  const saveAds = async (ads, listId) => {
    const res = await send({ type: "SAVE_ADS", ads, listId });
    if (!res.ok) {
      toast(
        res.error === "context_invalidated"
          ? "Reload the page to reconnect"
          : "Save failed",
      );
      return;
    }
    for (const ad of ads) savedIds.add(ad.id);
    toast(
      res.added === 0
        ? `Already in ${res.listName}`
        : `Saved ${res.added} to ${res.listName}`,
    );
    refreshSavedButtons();
  };

  const downloadAd = async (ad) => {
    if (!ad.media || ad.media.length === 0) {
      toast("No downloadable media on this ad");
      return;
    }
    const res = await send({ type: "DOWNLOAD_AD", ad });
    toast(
      res.ok
        ? `Downloading ${res.count} file${res.count === 1 ? "" : "s"}`
        : "Download failed",
    );
  };

  // ---------------------------------------------------------------------
  // Destination menu
  // ---------------------------------------------------------------------

  const closeMenu = () => {
    if (openMenu) {
      openMenu.remove();
      openMenu = null;
    }
  };

  document.addEventListener("click", (e) => {
    if (
      openMenu &&
      !openMenu.contains(e.target) &&
      !e.target.closest(".mal-caret")
    )
      closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });

  const openTargetMenu = (anchor, ad) => {
    closeMenu();
    const menu = document.createElement("div");
    menu.className = "mal-menu";

    const spaces = targets.spaces.length
      ? targets.spaces
      : [{ id: null, name: "My Library", kind: "personal" }];

    for (const space of spaces) {
      const header = document.createElement("div");
      header.className = "mal-menu-space";
      header.textContent =
        space.name + (space.kind === "team" ? "  ·  team" : "");
      menu.appendChild(header);

      const lists = targets.lists.filter((l) => l.spaceId === space.id);
      if (lists.length === 0) {
        const empty = document.createElement("div");
        empty.className = "mal-menu-empty";
        empty.textContent = "No lists yet";
        menu.appendChild(empty);
      }
      for (const list of lists) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "mal-menu-item";
        item.innerHTML = `<span class="mal-dot" style="background:${list.color}"></span><span class="mal-menu-name"></span><span class="mal-menu-count">${list.adIds.length}</span>`;
        item.querySelector(".mal-menu-name").textContent = list.name;
        item.addEventListener("click", (e) => {
          e.stopPropagation();
          closeMenu();
          saveAds([ad], list.id);
        });
        menu.appendChild(item);
      }
    }

    const footer = document.createElement("button");
    footer.type = "button";
    footer.className = "mal-menu-item mal-menu-foot";
    footer.textContent = "Manage lists in dashboard";
    footer.addEventListener("click", (e) => {
      e.stopPropagation();
      closeMenu();
      send({ type: "OPEN_DASHBOARD" });
    });
    menu.appendChild(footer);

    document.documentElement.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    const mh = menu.getBoundingClientRect().height;
    const below = window.innerHeight - rect.bottom;
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 262))}px`;
    menu.style.top =
      below < mh + 12
        ? `${Math.max(8, rect.top - mh - 6)}px`
        : `${rect.bottom + 6}px`;
    openMenu = menu;
  };

  // ---------------------------------------------------------------------
  // Card decoration
  // ---------------------------------------------------------------------

  const ID_RE = /\b(\d{12,20})\b/g;

  const refreshSavedButtons = () => {
    for (const bar of document.querySelectorAll(".mal-bar")) {
      const id = bar.dataset.malAdId;
      const btn = bar.querySelector(".mal-save-main");
      if (btn && savedIds.has(id)) {
        btn.textContent = "Saved";
        btn.classList.add("mal-is-saved");
      }
    }
  };

  /**
   * Walk up from the Library ID text to the card element. The card is the
   * first ancestor that also contains the creative, capped so a miss can never
   * select the whole results column.
   */
  const findCard = (el) => {
    let node = el;
    for (let i = 0; i < 14 && node && node !== document.body; i++) {
      if (node.querySelector && node.querySelector("img, video")) return node;
      node = node.parentElement;
    }
    return null;
  };

  /**
   * Facebook renders its own actions ("See ad details", "See summary details")
   * as a div[role=button] near the end of the card. Dropping our row next to
   * that keeps the controls in the card's natural button area instead of
   * covering the creative.
   */
  const findButtonAnchor = (card) => {
    const candidates = card.querySelectorAll(
      'div[role="button"], a[role="button"]',
    );
    let best = null;
    for (const c of candidates) {
      const text = (c.textContent || "").trim();
      if (!text || text.length > 40) continue;
      best = c;
    }
    return best;
  };

  const buildBar = (ad) => {
    const bar = document.createElement("div");
    bar.className = "mal-bar";
    bar.dataset.malAdId = ad.id;

    const group = document.createElement("div");
    group.className = "mal-split";

    const main = document.createElement("button");
    main.type = "button";
    main.className = "mal-btn mal-btn-primary mal-save-main";
    main.textContent = savedIds.has(ad.id) ? "Saved" : "Save";
    if (savedIds.has(ad.id)) main.classList.add("mal-is-saved");
    main.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      saveAds([ad]);
    });

    const caret = document.createElement("button");
    caret.type = "button";
    caret.className = "mal-btn mal-btn-primary mal-caret";
    caret.setAttribute("aria-label", "Choose a list");
    caret.innerHTML =
      '<svg width="10" height="6" viewBox="0 0 10 6"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    caret.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (openMenu) closeMenu();
      else openTargetMenu(caret, ad);
    });

    group.append(main, caret);

    const dl = document.createElement("button");
    dl.type = "button";
    dl.className = "mal-btn mal-btn-secondary";
    dl.textContent = "Download";
    dl.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      downloadAd(ad);
    });

    bar.append(group, dl);
    return bar;
  };

  const decorateCards = () => {
    if (captured.size === 0) return;

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

    const hits = [];
    let textNode;
    while ((textNode = walker.nextNode())) {
      ID_RE.lastIndex = 0;
      let m;
      while ((m = ID_RE.exec(textNode.nodeValue))) {
        if (captured.has(m[1])) {
          hits.push({ id: m[1], node: textNode });
          break;
        }
      }
    }

    for (const { id, node } of hits) {
      const card = findCard(node.parentElement);
      if (!card || card.querySelector(".mal-bar")) continue;
      const bar = buildBar(captured.get(id));
      const anchor = findButtonAnchor(card);
      if (anchor && anchor.parentElement) {
        anchor.parentElement.insertBefore(bar, anchor.nextSibling);
      } else {
        card.appendChild(bar);
      }
    }
  };

  const observer = new MutationObserver(() => {
    clearTimeout(observer.__malTimer);
    observer.__malTimer = setTimeout(decorateCards, 400);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // ---------------------------------------------------------------------
  // Capture panel
  // ---------------------------------------------------------------------

  const buildPanel = () => {
    const panel = document.createElement("div");
    panel.id = "mal-panel";
    panel.innerHTML = `
      <div class="mal-panel-row">
        <span class="mal-panel-mark"></span>
        <span class="mal-panel-title">Ads Saver</span>
        <span id="mal-panel-count" class="mal-panel-count">0</span>
      </div>
      <div class="mal-panel-actions">
        <button type="button" id="mal-save-all" class="mal-btn mal-btn-primary">Save all captured</button>
        <button type="button" id="mal-open-dash" class="mal-btn mal-btn-secondary">Dashboard</button>
      </div>`;
    document.documentElement.appendChild(panel);

    panel.querySelector("#mal-save-all").addEventListener("click", () => {
      const ads = [...captured.values()];
      if (ads.length === 0) {
        toast("Nothing captured yet. Scroll the results first.");
        return;
      }
      saveAds(ads);
    });
    panel.querySelector("#mal-open-dash").addEventListener("click", () => {
      send({ type: "OPEN_DASHBOARD" });
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

  refreshTargets();
  // Lists and spaces can change in the dashboard while this tab stays open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (
      area === "local" &&
      (changes.lists || changes.spaces || changes.settings)
    ) {
      refreshTargets();
    }
  });
})();
