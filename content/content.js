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
  const captured = new Map(); // adId -> ad from the GraphQL interceptor
  const mediaIndex = new Map(); // normalised creative URL -> captured ad
  const onPage = new Map(); // adId -> ad actually decorated on screen
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
    for (const ad of data.ads) {
      if (!ad || !ad.id) continue;
      captured.set(ad.id, ad);
      indexMedia(ad);
    }
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
    if (!res.ok) {
      toast(
        res.reason === "unusable"
          ? "This creative has no downloadable file"
          : "Download failed",
      );
      return;
    }
    const label =
      res.quality === "hd"
        ? " in HD"
        : res.quality === "low"
          ? " (page quality, HD not captured)"
          : "";
    toast(`Downloading ${res.count} file${res.count === 1 ? "" : "s"}${label}`);
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

  const isHorizontalFlex = (node) => {
    const s = getComputedStyle(node);
    return (
      (s.display === "flex" || s.display === "inline-flex") &&
      !s.flexDirection.startsWith("column")
    );
  };

  // "Library ID: 2027746121166762" and its localised equivalents are short.
  // Capping the length keeps long body copy that happens to contain a digit
  // run from being mistaken for a card's id line.
  const ID_TEXT_MAX = 64;

  /**
   * Every place the page prints an ad id, as {id, node}.
   *
   * Deliberately independent of what the GraphQL interceptor captured. The
   * number printed on a card is not always the id of the node we captured -
   * collated cards ("3 ads use this creative and text") nest their creatives
   * under a different archive id - and when those two sets did not intersect,
   * requiring a match meant no card was decorated at all.
   */
  const idOccurrences = () => {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (n) => {
          const v = n.nodeValue;
          if (!v || v.length > ID_TEXT_MAX) return NodeFilter.FILTER_REJECT;
          return /\d{12}/.test(v)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        },
      },
    );
    const out = [];
    let n;
    while ((n = walker.nextNode())) {
      if (n.parentElement && n.parentElement.closest("#mal-panel")) continue;
      ID_RE.lastIndex = 0;
      const m = ID_RE.exec(n.nodeValue);
      if (m) out.push({ id: m[1], node: n });
    }
    return out;
  };

  /** Distinct ad-id occurrences inside this subtree, counted up to two. */
  const idsInside = (node, all) => {
    let n = 0;
    for (const occ of all) {
      if (node.contains(occ.node)) {
        n += 1;
        if (n > 1) return 2;
      }
    }
    return n;
  };

  /**
   * The ad card's own root element.
   *
   * Anchoring to one of Facebook's buttons does not work: the last
   * role=button in a card is "See summary details" on some cards and the
   * "Shop now" CTA on others, so the row landed above the creative on some
   * and squeezed into the CTA's narrow row on others. Instead, climb from the
   * id text until the subtree mentions a second ad - meaning we have stepped
   * out of this card and into the results grid - and keep the outermost
   * element that still describes exactly this one ad.
   *
   * A column/block container is preferred, but a horizontal one is accepted,
   * and failing both we take the nearest ancestor holding the creative. This
   * must never return null: doing so silently leaves a card with no controls.
   */
  const findCardRoot = (node, all) => {
    let cur = node;
    let best = null;
    let anyShape = null;
    for (let i = 0; i < 25 && cur && cur !== document.body; i++) {
      const n = idsInside(cur, all);
      if (n > 1) break;
      if (n === 1 && cur.querySelector("img, video")) {
        anyShape = cur;
        if (!isHorizontalFlex(cur)) best = cur;
      }
      cur = cur.parentElement;
    }
    if (best || anyShape) return best || anyShape;
    let cheap = node;
    for (let i = 0; i < 14 && cheap && cheap !== document.body; i++) {
      if (cheap.querySelector && cheap.querySelector("img, video"))
        return cheap;
      cheap = cheap.parentElement;
    }
    return null;
  };

  /**
   * Put the row at the end of the card as its own full-width line. If the card
   * turned out to be a horizontal flex row, allow wrapping so the row drops
   * below Facebook's own children instead of being squeezed beside them.
   */
  const appendBar = (card, bar) => {
    if (
      isHorizontalFlex(card) &&
      getComputedStyle(card).flexWrap === "nowrap"
    ) {
      card.style.flexWrap = "wrap";
    }
    card.appendChild(bar);
  };

  /**
   * An ad assembled from the card's own DOM, for when the printed id was not
   * in the captured set. Less rich than the GraphQL record (no CTA type, no
   * HD video URL) but enough to save the ad and download what is on screen.
   */
  /**
   * Facebook's CDN URLs carry signed, short-lived query parameters that differ
   * between the copy embedded in the page and the copy in the GraphQL
   * response, so the path alone is the stable identity of a creative.
   */
  const mediaKey = (url) => {
    try {
      const u = new URL(url);
      return u.origin + u.pathname;
    } catch (err) {
      return url || "";
    }
  };

  const indexMedia = (ad) => {
    for (const m of ad.media || []) {
      for (const u of [m.url, m.previewUrl, m.hdUrl, m.sdUrl]) {
        if (u) mediaIndex.set(mediaKey(u), ad);
      }
    }
  };

  /**
   * Find the captured record for a card by matching its creative, for when the
   * printed id is not the archive id we captured. This is what recovers the
   * full-resolution video: the page's own <video> plays a lower-bitrate
   * variant (often a blob: MSE stream), while the GraphQL record carries
   * video_hd_url and the original, unresized image.
   */
  const matchByMedia = (card) => {
    for (const v of card.querySelectorAll("video")) {
      if (v.poster) {
        const hit = mediaIndex.get(mediaKey(v.poster));
        if (hit) return hit;
      }
    }
    for (const img of card.querySelectorAll("img")) {
      if (img.src) {
        const hit = mediaIndex.get(mediaKey(img.src));
        if (hit) return hit;
      }
    }
    return null;
  };

  // Lines that are chrome, not an advertiser name.
  const JUNK_NAME =
    /^(sponsored|active|inactive|\d+\s*ads?\b.*|library id.*|see .*|platforms?|started running.*|this ad has.*)$/i;

  /**
   * The advertiser on a card. Facebook prints the name directly above a
   * "Sponsored" label, which is far more reliable than "first bold element":
   * that picks up "3 ads use this creative and text" on collated cards.
   */
  const guessAdvertiser = (card) => {
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        /^\s*sponsored\s*$/i.test(n.nodeValue || "")
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT,
    });
    const sponsored = walker.nextNode();
    if (sponsored) {
      let cur = sponsored.parentElement;
      for (let i = 0; i < 4 && cur && cur !== card; i++) {
        let sib = cur.previousElementSibling;
        while (sib) {
          const t = (sib.textContent || "").trim().split("\n")[0].trim();
          if (t && t.length <= 60 && !JUNK_NAME.test(t)) return t;
          sib = sib.previousElementSibling;
        }
        cur = cur.parentElement;
      }
    }
    for (const n of card.querySelectorAll(
      "strong, b, h3, h4, a[role='link']",
    )) {
      const t = (n.textContent || "").trim();
      if (t && t.length <= 60 && !JUNK_NAME.test(t)) return t;
    }
    return "Unknown page";
  };

  /**
   * An ad assembled from the card's own DOM, for when the printed id was not
   * in the captured set. Less rich than the GraphQL record (no CTA type, no
   * HD video URL) but enough to save the ad and download what is on screen.
   */
  const adFromCard = (id, card) => {
    const media = [];
    for (const img of card.querySelectorAll("img")) {
      // Skip avatars and spacers; keep anything creative-sized.
      if (img.naturalWidth && img.naturalWidth < 120) continue;
      if (!/^https?:/.test(img.src || "")) continue;
      media.push({ type: "image", url: img.src, previewUrl: img.src });
    }
    for (const vid of card.querySelectorAll("video")) {
      // currentSrc is frequently a blob: MSE stream, which cannot be
      // downloaded; <source> children and src are the usable candidates.
      const candidates = [
        vid.currentSrc,
        vid.src,
        ...[...vid.querySelectorAll("source")].map((n) => n.src),
      ].filter((u) => u && /^https?:/.test(u));
      if (candidates.length) {
        media.push({
          type: "video",
          url: candidates[0],
          hdUrl: null,
          sdUrl: candidates[0],
          previewUrl: vid.poster || null,
          lowRes: true, // the page's playback copy, not the HD original
        });
      } else if (vid.poster) {
        media.push({ type: "image", url: vid.poster, previewUrl: vid.poster });
      }
    }
    const head = (card.textContent || "").slice(0, 300);
    return {
      id,
      pageName: guessAdvertiser(card),
      isActive: /\bactive\b/i.test(head) ? true : null,
      media,
      capturedAt: Date.now(),
      libraryUrl: `https://www.facebook.com/ads/library/?id=${id}`,
      fromDom: true,
    };
  };

  /** The card's action row: Save (with its destination caret) and Download. */
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

  let decoratedCount = 0;

  const decorateCards = () => {
    const all = idOccurrences();
    if (all.length === 0) return;

    const done = new Set();
    for (const occ of all) {
      if (done.has(occ.id)) continue;
      const card = findCardRoot(occ.node.parentElement, all);
      if (!card) continue;

      const existing = card.querySelector(".mal-bar");
      if (existing) {
        // The first pass runs before the interceptor has delivered anything,
        // so a card can be decorated from its DOM and only later have its
        // GraphQL record arrive. Upgrade in place when that happens, or the
        // card keeps downloading the page's low-resolution playback copy.
        const current = onPage.get(occ.id);
        if (current && current.fromDom) {
          const better = captured.get(occ.id) || matchByMedia(card);
          if (better) {
            const upgraded = {
              ...better,
              id: occ.id,
              libraryUrl: `https://www.facebook.com/ads/library/?id=${occ.id}`,
            };
            onPage.set(occ.id, upgraded);
            existing.replaceWith(buildBar(upgraded));
          }
        }
        done.add(occ.id);
        continue;
      }
      // Prefer the richer GraphQL record, by id or by matching the creative,
      // so downloads get video_hd_url and the original image rather than the
      // page's downscaled playback copy. Fall back to the card's own DOM so a
      // card is never left without controls.
      const matched = captured.get(occ.id) || matchByMedia(card);
      const ad = matched
        ? {
            ...matched,
            id: occ.id,
            libraryUrl: `https://www.facebook.com/ads/library/?id=${occ.id}`,
          }
        : adFromCard(occ.id, card);
      onPage.set(occ.id, ad);
      appendBar(card, buildBar(ad));
      done.add(occ.id);
    }
    decoratedCount = document.querySelectorAll(".mal-bar").length;
    renderPanel();
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
          <span class="mal-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <rect x="1" y="7" width="8.5" height="10" rx="2" fill="currentColor" opacity=".26"/>
              <rect x="6" y="5" width="9.5" height="14" rx="2.2" fill="currentColor" opacity=".5"/>
              <rect x="12" y="3" width="11" height="18" rx="2.6" fill="currentColor"/>
            </svg>
          </span>
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
    try {
      localStorage.setItem("mal.panelOpen", "1");
    } catch (err) {
      /* storage blocked; the panel still opens for this session */
    }
    refreshStore();
  };

  const closePanel = () => {
    panelEl.classList.add("mal-closed");
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

  /** Creative format, mirroring the dashboard's rule. */
  const formatOf = (ad) => {
    const kinds = (ad.media || []).length
      ? ad.media.map((m) => m.type)
      : ad.mediaKinds || [];
    if (kinds.filter((k) => k !== "video").length > 1) return "carousel";
    if (kinds.some((k) => k === "video")) return "video";
    if (kinds.length) return "image";
    return "text";
  };

  const thumbOf = (ad) => {
    if (ad.thumbDataUrl) return ad.thumbDataUrl;
    const m = (ad.media || []).find((x) => x.previewUrl) || (ad.media || [])[0];
    return (m && (m.previewUrl || (m.type === "image" ? m.url : null))) || null;
  };

  /** Lists in the active space that hold this ad, for its colour chips. */
  const listsForAd = (id) =>
    Object.values(store.lists || {}).filter(
      (l) =>
        l.spaceId === (store.settings || {}).activeSpaceId &&
        (l.adIds || []).includes(id),
    );

  /**
   * A compact version of the dashboard's ad card: creative, status and format
   * badges, advertiser, longevity, list colour, and the two actions.
   */
  const miniCard = (ad) => {
    const card = el("div", "mal-mini");

    const media = el("div", "mal-mini-media");
    const thumb = thumbOf(ad);
    if (thumb) {
      const img = el("img");
      img.src = thumb;
      img.alt = "";
      img.loading = "lazy";
      media.appendChild(img);
    } else {
      media.appendChild(
        el(
          "div",
          "mal-mini-ph",
          (ad.pageName || "?").slice(0, 1).toUpperCase(),
        ),
      );
    }
    if (ad.isActive === true)
      media.appendChild(el("span", "mal-mini-badge mal-mini-live", "ACTIVE"));
    else if (ad.isActive === false)
      media.appendChild(el("span", "mal-mini-badge mal-mini-ended", "ENDED"));
    media.appendChild(
      el("span", "mal-mini-badge mal-mini-fmt", formatOf(ad).toUpperCase()),
    );
    media.addEventListener("click", () => window.open(ad.libraryUrl, "_blank"));
    card.appendChild(media);

    const body = el("div", "mal-mini-body");
    const name = el("div", "mal-mini-name", ad.pageName || "Unknown page");
    name.title = "Open in the Ad Library";
    name.addEventListener("click", () => window.open(ad.libraryUrl, "_blank"));
    body.appendChild(name);

    const days = daysRunning(ad);
    body.appendChild(
      el(
        "div",
        "mal-mini-sub",
        [
          days != null ? `${days}d running` : null,
          ad.savedBy ? `by ${ad.savedBy}` : null,
        ]
          .filter(Boolean)
          .join(" · ") || "\u2014",
      ),
    );

    const lists = listsForAd(ad.id);
    if (lists.length) {
      const chips = el("div", "mal-mini-chips");
      for (const l of lists.slice(0, 2)) {
        const chip = el("span", "mal-mini-chip");
        const dot = el("span", "mal-dot");
        dot.style.background = l.color;
        chip.append(dot, el("span", null, l.name));
        chips.appendChild(chip);
      }
      body.appendChild(chips);
    }

    // At mini width two labelled buttons do not fit, so Download is the one
    // full-width action and the creative itself opens the ad.
    const actions = el("div", "mal-mini-actions");
    const dl = el("button", "mal-btn mal-btn-primary mal-mini-btn", "Download");
    dl.type = "button";
    dl.addEventListener("click", () => downloadAd(ad));
    actions.appendChild(dl);
    body.appendChild(actions);

    card.appendChild(body);
    return card;
  };

  const miniGrid = (ads) => {
    const grid = el("div", "mal-mini-grid");
    for (const ad of ads) grid.appendChild(miniCard(ad));
    return grid;
  };

  const renderHome = (body) => {
    // Everything the page is actually showing, whether it came from the
    // network capture or was read off the card itself.
    const pageAds = [...onPage.values()];
    const newCount = pageAds.filter((a) => !savedIds.has(a.id)).length;

    const capture = el("div", "mal-card");
    capture.append(
      el("div", "mal-card-title", `${pageAds.length} ads on this page`),
      el(
        "div",
        "mal-card-sub",
        pageAds.length === 0
          ? "Scroll the results to load ads."
          : newCount === 0
            ? "All of them are already saved."
            : `${newCount} not saved yet. Keep scrolling for more.`,
      ),
    );
    const saveAll = el(
      "button",
      "mal-btn mal-btn-primary mal-full",
      "Save all on page",
    );
    saveAll.type = "button";
    saveAll.disabled = newCount === 0;
    saveAll.addEventListener("click", () => {
      if (!pageAds.length) {
        toast("No ads detected yet. Scroll the results first.");
        return;
      }
      saveAds(pageAds);
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
      body.appendChild(miniGrid(saved.slice(0, 4)));
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
    body.appendChild(miniGrid(saved.slice(0, 50)));
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

    // Detection readout: if cards are on screen but none were decorated, this
    // says so rather than the buttons just being quietly absent.
    body.appendChild(el("div", "mal-section", "Detection"));
    const matched = [...onPage.keys()].filter((id) => captured.has(id)).length;
    const diag = el("div", "mal-card");
    diag.append(
      el("div", "mal-card-sub", `${onPage.size} ad cards found on the page`),
      el(
        "div",
        "mal-card-sub",
        `${decoratedCount} have Save / Download buttons`,
      ),
      el(
        "div",
        "mal-card-sub",
        `${captured.size} captured from the network, ${matched} matched to a card`,
      ),
    );
    body.appendChild(diag);
  };

  const renderPanel = () => {
    if (!panelEl) return;
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
    // Decorate straight away, then sweep a few times. Results are usually
    // already rendered before this script runs, and the interceptor's message
    // can land before this listener exists, so waiting on either of those for
    // the first pass leaves every card without controls.
    decorateCards();
    for (const delay of [400, 1200, 2500, 5000])
      setTimeout(decorateCards, delay);
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

  // The toolbar button toggles the panel; there is no floating launcher.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "TOGGLE_PANEL") return false;
    if (!panelEl) buildPanel();
    if (panelEl.classList.contains("mal-closed")) openPanel();
    else closePanel();
    sendResponse({ ok: true });
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.lists || changes.spaces || changes.settings) refreshTargets();
    if (changes.ads || changes.lists || changes.spaces) refreshStore();
  });
})();
