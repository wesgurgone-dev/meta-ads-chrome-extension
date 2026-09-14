/**
 * Isolated-world content script for facebook.com/ads/library.
 *
 * Two jobs:
 *   1. Decorate each ad card with a Save split-button and a Download button,
 *      styled like Facebook's own controls and laid out as their own row.
 *   2. Run the side panel: a slide-out workspace showing what has been
 *      captured, what is saved, and the colour-coded lists, so the common
 *      work happens here instead of bouncing to the dashboard.
 */
(() => {
  "use strict";

  const MSG_TYPE = "MAL_ADS_CAPTURED";
  const captured = new Map(); // adId -> normalized ad
  const savedIds = new Set();

  let targets = {
    spaces: [],
    lists: [],
    activeSpaceId: null,
    defaultListId: null,
  };
  let store = { ads: {}, lists: {}, spaces: {}, settings: {}, identity: {} };
  let openMenu = null;
  let panelEl = null;
  let launcherEl = null;
  let view = "home";

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
      defaultListId: res.defaultListId,
    };
    for (const id of res.savedIds || []) savedIds.add(id);
    refreshSavedButtons();
  };

  const refreshStore = async () => {
    const res = await send({ type: "GET_STATE" });
    if (res.ok) store = res;
    renderPanel();
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.type !== MSG_TYPE || !Array.isArray(data.ads)) return;
    for (const ad of data.ads) if (ad && ad.id) captured.set(ad.id, ad);
    decorateCards();
    renderPanel();
  });

  // ---------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const daysRunning = (ad) => {
    if (!ad.startDate) return null;
    const end = ad.isActive === false && ad.endDate ? ad.endDate : Date.now();
    return Math.max(1, Math.round((end - ad.startDate) / 86400000));
  };

  const activeLists = () =>
    targets.lists.filter((l) => l.spaceId === targets.activeSpaceId);

  const activeSpace = () =>
    targets.spaces.find((s) => s.id === targets.activeSpaceId) || null;

  /** Ads saved in the active space, newest first. */
  const savedInSpace = () => {
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

  const toast = (message) => {
    let node = document.getElementById("mal-toast");
    if (!node) {
      node = el("div");
      node.id = "mal-toast";
      document.documentElement.appendChild(node);
    }
    node.textContent = message;
    node.classList.add("mal-toast-visible");
    clearTimeout(node.__malTimer);
    node.__malTimer = setTimeout(
      () => node.classList.remove("mal-toast-visible"),
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
    refreshTargets();
    refreshStore();
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
    const menu = el("div", "mal-menu");

    const spaces = targets.spaces.length
      ? targets.spaces
      : [{ id: null, name: "My Library", kind: "personal" }];

    for (const space of spaces) {
      menu.appendChild(
        el(
          "div",
          "mal-menu-space",
          space.name + (space.kind === "team" ? "  ·  team" : ""),
        ),
      );
      const lists = targets.lists.filter((l) => l.spaceId === space.id);
      if (lists.length === 0)
        menu.appendChild(el("div", "mal-menu-empty", "No lists yet"));
      for (const list of lists) {
        const item = el("button", "mal-menu-item");
        item.type = "button";
        const dot = el("span", "mal-dot");
        dot.style.background = list.color;
        const name = el("span", "mal-menu-name", list.name);
        const count = el("span", "mal-menu-count", String(list.adIds.length));
        item.append(dot, name, count);
        item.addEventListener("click", (e) => {
          e.stopPropagation();
          closeMenu();
          saveAds([ad], list.id);
        });
        menu.appendChild(item);
      }
    }

    const foot = el(
      "button",
      "mal-menu-item mal-menu-foot",
      "Manage lists in the panel",
    );
    foot.type = "button";
    foot.addEventListener("click", (e) => {
      e.stopPropagation();
      closeMenu();
      setView("lists");
      openPanel();
    });
    menu.appendChild(foot);

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
      const btn = bar.querySelector(".mal-save-main");
      if (btn && savedIds.has(bar.dataset.malAdId)) {
        btn.textContent = "Saved";
        btn.classList.add("mal-is-saved");
      }
    }
  };

  const findCard = (node) => {
    let cur = node;
    for (let i = 0; i < 14 && cur && cur !== document.body; i++) {
      if (cur.querySelector && cur.querySelector("img, video")) return cur;
      cur = cur.parentElement;
    }
    return null;
  };

  /** Facebook's own card action, e.g. "See ad details" / "See summary details". */
  const findButtonAnchor = (card) => {
    const candidates = card.querySelectorAll(
      'div[role="button"], a[role="button"]',
    );
    let best = null;
    for (const c of candidates) {
      const text = (c.textContent || "").trim();
      if (!text || text.length > 40) continue;
      if (c.querySelector(".mal-bar")) continue;
      best = c;
    }
    return best;
  };

  const isHorizontalFlex = (node) => {
    const s = getComputedStyle(node);
    return (
      (s.display === "flex" || s.display === "inline-flex") &&
      !s.flexDirection.startsWith("column")
    );
  };

  /**
   * Facebook lays its card buttons out inside horizontal flex rows. Inserting
   * directly beside its button makes our bar just another item in that row,
   * which squeezes and clips it. So climb to the outermost node still sitting
   * in a horizontal row and insert after that, giving the bar its own line.
   */
  const insertBar = (card, bar) => {
    const anchor = findButtonAnchor(card);
    if (!anchor || !anchor.parentElement) {
      card.appendChild(bar);
      return;
    }
    let node = anchor;
    while (
      node.parentElement &&
      node.parentElement !== card &&
      node.parentElement !== document.body &&
      isHorizontalFlex(node.parentElement)
    ) {
      node = node.parentElement;
    }
    if (node.parentElement)
      node.parentElement.insertBefore(bar, node.nextSibling);
    else card.appendChild(bar);
  };

  const buildBar = (ad) => {
    const bar = el("div", "mal-bar");
    bar.dataset.malAdId = ad.id;

    const group = el("div", "mal-split");

    const main = el("button", "mal-btn mal-btn-primary mal-save-main");
    main.type = "button";
    main.textContent = savedIds.has(ad.id) ? "Saved" : "Save";
    if (savedIds.has(ad.id)) main.classList.add("mal-is-saved");
    main.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      saveAds([ad]);
    });

    const caret = el("button", "mal-btn mal-btn-primary mal-caret");
    caret.type = "button";
    caret.setAttribute("aria-label", "Choose a list");
    caret.innerHTML =
      '<svg width="10" height="6" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    caret.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (openMenu) closeMenu();
      else openTargetMenu(caret, ad);
    });

    group.append(main, caret);

    const dl = el("button", "mal-btn mal-btn-secondary", "Download");
    dl.type = "button";
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
      if (
        textNode.parentElement &&
        textNode.parentElement.closest("#mal-panel")
      )
        continue;
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
      insertBar(card, buildBar(captured.get(id)));
    }
  };

  const observer = new MutationObserver(() => {
    clearTimeout(observer.__malTimer);
    observer.__malTimer = setTimeout(decorateCards, 400);
  });

  // ---------------------------------------------------------------------
  // Side panel
  // ---------------------------------------------------------------------

  const ICONS = {
    home: '<path d="M3 9.5L10 4l7 5.5V16a1 1 0 01-1 1h-4v-4H8v4H4a1 1 0 01-1-1V9.5z"/>',
    saved: '<path d="M5 3h10a1 1 0 011 1v13l-6-3.5L4 17V4a1 1 0 011-1z"/>',
    lists:
      '<path d="M3 5h3v3H3V5zm5 .5h9v2H8v-2zM3 11h3v3H3v-3zm5 .5h9v2H8v-2z"/>',
    account:
      '<path d="M10 10a3.5 3.5 0 100-7 3.5 3.5 0 000 7zm0 1.8c-3.3 0-6 1.8-6 4v1.2h12V15.8c0-2.2-2.7-4-6-4z"/>',
  };

  const buildPanel = () => {
    launcherEl = el("button", "mal-launcher");
    launcherEl.type = "button";
    launcherEl.innerHTML =
      '<span class="mal-launcher-mark"></span><span class="mal-launcher-text">Ads Saver</span><span class="mal-launcher-count">0</span>';
    launcherEl.addEventListener("click", openPanel);
    document.documentElement.appendChild(launcherEl);

    panelEl = el("div", "mal-panel mal-closed");
    panelEl.id = "mal-panel";
    panelEl.innerHTML = `
      <nav class="mal-rail">
        ${["home", "saved", "lists", "account"]
          .map(
            (k) => `<button type="button" class="mal-rail-btn" data-view="${k}">
              <svg viewBox="0 0 20 20" width="19" height="19" aria-hidden="true">${ICONS[k]}</svg>
              <span>${k === "account" ? "Account" : k[0].toUpperCase() + k.slice(1)}</span>
            </button>`,
          )
          .join("")}
      </nav>
      <div class="mal-main">
        <header class="mal-head">
          <div>
            <div class="mal-head-title">Ads Saver</div>
            <div class="mal-head-sub" id="mal-head-sub"></div>
          </div>
          <button type="button" class="mal-x" aria-label="Close panel">&#10005;</button>
        </header>
        <div class="mal-view" id="mal-view"></div>
        <footer class="mal-foot">
          <button type="button" class="mal-btn mal-btn-secondary mal-full" id="mal-open-dash">
            Open full dashboard
          </button>
        </footer>
      </div>`;
    document.documentElement.appendChild(panelEl);

    panelEl.querySelector(".mal-x").addEventListener("click", closePanel);
    panelEl
      .querySelector("#mal-open-dash")
      .addEventListener("click", () => send({ type: "OPEN_DASHBOARD" }));
    panelEl.querySelectorAll(".mal-rail-btn").forEach((btn) => {
      btn.addEventListener("click", () => setView(btn.dataset.view));
    });
  };

  const openPanel = () => {
    if (!panelEl) buildPanel();
    panelEl.classList.remove("mal-closed");
    launcherEl.classList.add("mal-hidden");
    try {
      localStorage.setItem("mal.panelOpen", "1");
    } catch (err) {
      /* storage blocked; the panel still opens for this session */
    }
    refreshStore();
  };

  const closePanel = () => {
    panelEl.classList.add("mal-closed");
    launcherEl.classList.remove("mal-hidden");
    try {
      localStorage.setItem("mal.panelOpen", "0");
    } catch (err) {
      /* ignore */
    }
  };

  const setView = (next) => {
    view = next;
    renderPanel();
  };

  const statTile = (value, label) => {
    const t = el("div", "mal-stat");
    t.append(
      el("div", "mal-stat-value", String(value)),
      el("div", "mal-stat-label", label),
    );
    return t;
  };

  const adRow = (ad) => {
    const row = el("div", "mal-ad");
    const thumb = el("div", "mal-ad-thumb");
    if (ad.thumbDataUrl) {
      const img = el("img");
      img.src = ad.thumbDataUrl;
      img.alt = "";
      thumb.appendChild(img);
    } else {
      thumb.textContent = (ad.pageName || "?").slice(0, 1).toUpperCase();
    }
    const meta = el("div", "mal-ad-meta");
    meta.append(el("div", "mal-ad-name", ad.pageName || "Unknown page"));
    const days = daysRunning(ad);
    const bits = [];
    if (days != null) bits.push(`${days}d running`);
    if (ad.isActive === true) bits.push("active");
    else if (ad.isActive === false) bits.push("ended");
    meta.append(el("div", "mal-ad-sub", bits.join(" · ")));
    row.append(thumb, meta);

    const open = el("a", "mal-ad-open", "View");
    open.href = ad.libraryUrl || "#";
    open.target = "_blank";
    open.rel = "noreferrer";
    row.appendChild(open);
    return row;
  };

  const renderHome = (body) => {
    const newCount = [...captured.keys()].filter(
      (id) => !savedIds.has(id),
    ).length;

    const capture = el("div", "mal-card");
    capture.append(
      el("div", "mal-card-title", `${captured.size} ads captured on this page`),
      el(
        "div",
        "mal-card-sub",
        newCount === 0
          ? "All captured ads are already saved."
          : `${newCount} not saved yet. Keep scrolling to capture more.`,
      ),
    );
    const saveAll = el(
      "button",
      "mal-btn mal-btn-primary mal-full",
      "Save all captured",
    );
    saveAll.type = "button";
    saveAll.disabled = newCount === 0;
    saveAll.addEventListener("click", () => {
      const ads = [...captured.values()];
      if (!ads.length) {
        toast("Nothing captured yet. Scroll the results first.");
        return;
      }
      saveAds(ads);
    });
    capture.appendChild(saveAll);
    body.appendChild(capture);

    const saved = savedInSpace();
    const week = saved.filter(
      (a) => (a.savedAt || 0) >= Date.now() - 7 * 86400000,
    ).length;
    const active = saved.filter((a) => a.isActive === true).length;
    const stats = el("div", "mal-stats");
    stats.append(
      statTile(saved.length, "Saved"),
      statTile(week, "This week"),
      statTile(activeLists().length, "Lists"),
      statTile(active, "Active"),
    );
    body.appendChild(stats);

    body.appendChild(el("div", "mal-section", "Recently saved"));
    if (saved.length === 0) {
      body.appendChild(
        el("div", "mal-empty", "Nothing saved in this space yet."),
      );
    } else {
      for (const ad of saved.slice(0, 4)) body.appendChild(adRow(ad));
    }
  };

  const renderSaved = (body) => {
    const saved = savedInSpace();
    body.appendChild(
      el("div", "mal-section", `${saved.length} saved in this space`),
    );
    if (saved.length === 0) {
      body.appendChild(
        el("div", "mal-empty", "Save an ad and it shows up here."),
      );
      return;
    }
    for (const ad of saved.slice(0, 50)) body.appendChild(adRow(ad));
    if (saved.length > 50)
      body.appendChild(
        el(
          "div",
          "mal-empty",
          `Showing the 50 most recent. Open the dashboard for all.`,
        ),
      );
  };

  const renderLists = (body) => {
    const lists = activeLists();
    body.appendChild(el("div", "mal-section", "Lists in this space"));
    body.appendChild(
      el(
        "div",
        "mal-card-sub",
        "Pick a list to make it the default for new saves.",
      ),
    );
    if (lists.length === 0)
      body.appendChild(el("div", "mal-empty", "No lists yet."));
    for (const list of lists) {
      const isDefault = list.id === targets.defaultListId;
      const row = el(
        "button",
        "mal-list-row" + (isDefault ? " mal-is-default" : ""),
      );
      row.type = "button";
      const dot = el("span", "mal-dot");
      dot.style.background = list.color;
      const name = el("span", "mal-list-name", list.name);
      const count = el("span", "mal-list-count", String(list.adIds.length));
      row.append(dot, name, count);
      if (isDefault) row.append(el("span", "mal-default-tag", "default"));
      row.addEventListener("click", async () => {
        await send({
          type: "SET_DEFAULT_LIST",
          listId: isDefault ? null : list.id,
        });
        await refreshTargets();
        renderPanel();
        toast(isDefault ? "Default cleared" : `New saves go to ${list.name}`);
      });
      body.appendChild(row);
    }

    const add = el(
      "button",
      "mal-btn mal-btn-secondary mal-full",
      "+ New list",
    );
    add.type = "button";
    add.addEventListener("click", async () => {
      const name = prompt("List name:");
      if (!name) return;
      await send({ type: "LIST_OP", op: "create", name });
      await refreshTargets();
      renderPanel();
    });
    body.appendChild(add);
  };

  const renderAccount = (body) => {
    const space = activeSpace();
    body.appendChild(el("div", "mal-section", "Space"));
    const sel = el("select", "mal-select");
    for (const s of targets.spaces) {
      const opt = el(
        "option",
        null,
        s.name + (s.kind === "team" ? " (team)" : ""),
      );
      opt.value = s.id;
      if (s.id === targets.activeSpaceId) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", async () => {
      await send({ type: "SPACE_OP", op: "activate", spaceId: sel.value });
      await refreshTargets();
      await refreshStore();
    });
    body.appendChild(sel);

    if (space && space.kind === "team") {
      const code = el("div", "mal-card");
      code.append(
        el("div", "mal-card-sub", "Team join code"),
        el("div", "mal-code", space.code),
        el(
          "div",
          "mal-card-sub",
          "Teammates merge your exported space file to combine lists.",
        ),
      );
      body.appendChild(code);
    }

    body.appendChild(el("div", "mal-section", "Saved as"));
    body.appendChild(
      el(
        "div",
        "mal-card-sub",
        store.identity ? store.identity.displayName || "Me" : "Me",
      ),
    );
    body.appendChild(
      el(
        "div",
        "mal-empty",
        "Team sharing, sync and export live in the full dashboard.",
      ),
    );
  };

  const renderPanel = () => {
    if (!panelEl) return;
    if (launcherEl)
      launcherEl.querySelector(".mal-launcher-count").textContent = String(
        captured.size,
      );
    if (panelEl.classList.contains("mal-closed")) return;

    const space = activeSpace();
    panelEl.querySelector("#mal-head-sub").textContent = space
      ? space.name + (space.kind === "team" ? " · team" : "")
      : "Meta Ad Library";

    panelEl.querySelectorAll(".mal-rail-btn").forEach((b) => {
      b.classList.toggle("mal-active", b.dataset.view === view);
    });

    const body = panelEl.querySelector("#mal-view");
    body.innerHTML = "";
    if (view === "home") renderHome(body);
    else if (view === "saved") renderSaved(body);
    else if (view === "lists") renderLists(body);
    else renderAccount(body);
  };

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------

  const boot = async () => {
    buildPanel();
    observer.observe(document.body, { childList: true, subtree: true });
    await refreshTargets();
    await refreshStore();
    let wasOpen = "0";
    try {
      wasOpen = localStorage.getItem("mal.panelOpen") || "0";
    } catch (err) {
      /* ignore */
    }
    if (wasOpen === "1") openPanel();
    else renderPanel();
  };

  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot, { once: true });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.lists || changes.spaces || changes.settings) refreshTargets();
    if (changes.ads || changes.lists || changes.spaces) refreshStore();
  });
})();
