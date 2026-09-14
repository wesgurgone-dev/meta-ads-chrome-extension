/**
 * Isolated-world content script for facebook.com/ads/library.
 *
 * One job: decorate each ad card with a Save split-button and a Download
 * button, styled like Facebook's own controls and laid out as their own row.
 *
 * The workspace UI used to live here as an injected panel. It is now a real
 * browser side panel (panel/panel.html), so this script's only other duty is
 * answering GET_PAGE_ADS and telling the panel when what is on screen changed.
 */
(() => {
  "use strict";

  // Injected on demand as well as declared, so this file can be evaluated
  // twice in the same isolated world. The second run must do nothing.
  if (window.__malContentLoaded) return;
  window.__malContentLoaded = true;

  // Re-read rather than snapshot: Facebook is a single-page app, so a tab can
  // reach the Library without this script ever being evaluated again.
  const onLibrary = () => /facebook\.com\/ads\/library/.test(location.href);
  let libraryMode = false;

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
    theme: "system",
  };
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
      theme: res.theme || "system",
    };
    for (const id of res.savedIds || []) savedIds.add(id);
    refreshSavedButtons();
  };

  /** The panel holds its own copy of the store; nudge it to re-read. */
  const notifyPanel = () => {
    try {
      chrome.runtime.sendMessage({ type: "PAGE_ADS_CHANGED" }, () => {
        void chrome.runtime.lastError; // no panel open is the normal case
      });
    } catch (err) {
      /* extension context went away; the page reload will reconnect */
    }
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
    notifyPanel();
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

  const activeSpace = () =>
    targets.spaces.find((s) => s.id === targets.activeSpaceId) || null;

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
    notifyPanel();
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
      send({ type: "OPEN_PANEL" });
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
    // The one gate every entry point passes through: boot, the observer, and
    // the interceptor message. Off the Library a 12-to-20 digit run in the
    // page text is just a number, not an ad id.
    if (!onLibrary()) return;
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
    notifyPanel();
  };

  const observer = new MutationObserver(() => {
    clearTimeout(observer.__malTimer);
    observer.__malTimer = setTimeout(decorateCards, 400);
  });

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------

  // Card decoration is Library-only work: starting a subtree observer on every
  // page the panel is opened on would cost every visitor of every site nothing
  // but battery. Idempotent, so a SPA navigation onto the Library can start it
  // late without restarting anything.
  const ensureLibraryMode = () => {
    if (libraryMode || !onLibrary() || !document.body) return;
    libraryMode = true;
    observer.observe(document.body, { childList: true, subtree: true });
    // Decorate straight away, then sweep a few times. Results are usually
    // already rendered before this script runs, and the interceptor's message
    // can land before this listener exists, so waiting on either of those for
    // the first pass leaves every card without controls.
    decorateCards();
    for (const delay of [400, 1200, 2500, 5000])
      setTimeout(decorateCards, delay);
  };

  const boot = async () => {
    ensureLibraryMode();
    await refreshTargets();
    notifyPanel();
  };

  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot, { once: true });

  /**
   * The side panel cannot read this page, so it asks. A tab without this
   * script simply never answers, which the panel reads as "nothing here".
   */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "GET_PAGE_ADS") return false;
    sendResponse({
      ok: true,
      onLibrary: onLibrary(),
      ads: [...onPage.values()],
      found: onPage.size,
      decorated: decoratedCount,
      matched: [...onPage.keys()].filter((id) => captured.has(id)).length,
    });
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.lists || changes.spaces || changes.settings) refreshTargets();
  });
})();
