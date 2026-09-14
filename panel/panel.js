/**
 * Side panel page.
 *
 * Docked in the browser rather than injected into the page, so it survives
 * navigation, works on every tab, and never fights Facebook for the compositor.
 * The cost is that it cannot read the page: what is on screen comes from the
 * content script over chrome.tabs.sendMessage, and a tab with no content
 * script simply reports nothing rather than erroring.
 */
(() => {
  "use strict";

  let targets = {
    spaces: [],
    lists: [],
    activeSpaceId: null,
    defaultListId: null,
    theme: "system",
  };
  let store = { ads: {}, lists: {}, spaces: {}, settings: {}, identity: {} };
  let page = { ads: [], onLibrary: false, found: 0, decorated: 0, matched: 0 };
  let view = "home";

  const $ = (sel) => document.querySelector(sel);

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const send = (msg) =>
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
   * (any page but the Ad Library) rejects, and that is the normal case, not an
   * error: it just means there is nothing on screen to capture.
   */
  const askPage = async () => {
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab || !tab.id) return { ads: [], onLibrary: false };
      const res = await chrome.tabs.sendMessage(tab.id, {
        type: "GET_PAGE_ADS",
      });
      return res && res.ok ? res : { ads: [], onLibrary: false };
    } catch (err) {
      return { ads: [], onLibrary: false };
    }
  };

  const toast = (message) => {
    const node = $("#toast");
    node.textContent = message;
    node.classList.add("show");
    clearTimeout(node.__timer);
    node.__timer = setTimeout(() => node.classList.remove("show"), 2400);
  };

  // ---------------------------------------------------------------------
  // Derived data
  // ---------------------------------------------------------------------

  const activeLists = () =>
    targets.lists.filter((l) => l.spaceId === targets.activeSpaceId);

  const activeSpace = () =>
    targets.spaces.find((s) => s.id === targets.activeSpaceId) || null;

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

  const savedIdSet = () => new Set(savedInSpace().map((a) => a.id));

  const daysRunning = (ad) => {
    if (!ad.startDate) return null;
    const end = ad.isActive === false && ad.endDate ? ad.endDate : Date.now();
    return Math.max(1, Math.round((end - ad.startDate) / 86400000));
  };

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

  const listsForAd = (id) =>
    Object.values(store.lists || {}).filter(
      (l) =>
        l.spaceId === (store.settings || {}).activeSpaceId &&
        (l.adIds || []).includes(id),
    );

  // ---------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------

  const saveAds = async (ads, listId) => {
    const res = await send({ type: "SAVE_ADS", ads, listId });
    if (!res.ok) {
      toast("Save failed");
      return;
    }
    toast(
      res.added === 0
        ? `Already in ${res.listName}`
        : `Saved ${res.added} to ${res.listName}`,
    );
    await refreshAll();
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
  // Pieces
  // ---------------------------------------------------------------------

  const statTile = (value, label) => {
    const t = el("div", "bubble stat");
    t.append(
      el("div", "stat-value", String(value)),
      el("div", "stat-label", label),
    );
    return t;
  };

  const openInLibrary = (ad) => {
    if (ad.libraryUrl) chrome.tabs.create({ url: ad.libraryUrl });
  };

  const miniCard = (ad) => {
    const card = el("div", "bubble mini");

    const media = el("div", "mini-media");
    const thumb = thumbOf(ad);
    if (thumb) {
      const img = el("img");
      img.src = thumb;
      img.alt = "";
      img.loading = "lazy";
      media.appendChild(img);
    } else {
      media.appendChild(
        el("div", "mini-ph", (ad.pageName || "?").slice(0, 1).toUpperCase()),
      );
    }
    if (ad.isActive === true)
      media.appendChild(el("span", "mini-badge mini-live", "ACTIVE"));
    else if (ad.isActive === false)
      media.appendChild(el("span", "mini-badge mini-ended", "ENDED"));
    media.appendChild(
      el("span", "mini-badge mini-fmt", formatOf(ad).toUpperCase()),
    );
    media.addEventListener("click", () => openInLibrary(ad));
    card.appendChild(media);

    const body = el("div", "mini-body");
    const name = el("div", "mini-name", ad.pageName || "Unknown page");
    name.title = "Open in the Ad Library";
    name.addEventListener("click", () => openInLibrary(ad));
    body.appendChild(name);

    const days = daysRunning(ad);
    body.appendChild(
      el(
        "div",
        "mini-sub",
        [
          days != null ? `${days}d running` : null,
          ad.savedBy ? `by ${ad.savedBy}` : null,
        ]
          .filter(Boolean)
          .join(" · ") || "—",
      ),
    );

    const lists = listsForAd(ad.id);
    if (lists.length) {
      const chips = el("div", "mini-chips");
      for (const l of lists.slice(0, 2)) {
        const chip = el("span", "mini-chip");
        const dot = el("span", "dot");
        dot.style.background = l.color;
        chip.append(dot, el("span", null, l.name));
        chips.appendChild(chip);
      }
      body.appendChild(chips);
    }

    const dl = el("button", "btn mini-btn", "Download");
    dl.type = "button";
    dl.addEventListener("click", () => downloadAd(ad));
    body.appendChild(dl);

    card.appendChild(body);
    return card;
  };

  const grid = (ads) => {
    const g = el("div", "grid");
    for (const ad of ads) g.appendChild(miniCard(ad));
    return g;
  };

  // ---------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------

  const renderSummary = (body) => {
    const saved = savedInSpace();
    const week = saved.filter(
      (a) => (a.savedAt || 0) >= Date.now() - 7 * 86400000,
    ).length;
    const active = saved.filter((a) => a.isActive === true).length;
    const stats = el("div", "stats");
    stats.append(
      statTile(saved.length, "Saved"),
      statTile(week, "Week"),
      statTile(activeLists().length, "Lists"),
      statTile(active, "Active"),
    );
    body.appendChild(stats);

    body.appendChild(el("div", "section", "Recently saved"));
    if (saved.length === 0)
      body.appendChild(el("div", "empty", "Nothing saved in this space yet."));
    else body.appendChild(grid(saved.slice(0, 4)));
  };

  const renderHome = (body) => {
    const card = el("div", "bubble card");

    if (!page.onLibrary) {
      card.append(
        el("div", "card-title", "Not on the Ad Library"),
        el(
          "div",
          "card-sub",
          "Your library is below. Open the Ad Library to capture new ads.",
        ),
      );
      body.appendChild(card);
      renderSummary(body);
      return;
    }

    const saved = savedIdSet();
    const fresh = page.ads.filter((a) => !saved.has(a.id));
    card.append(
      el(
        "div",
        "card-title",
        `${page.ads.length} ad${page.ads.length === 1 ? "" : "s"} on this page`,
      ),
      el(
        "div",
        "card-sub",
        page.ads.length === 0
          ? "Scroll the results to load ads."
          : fresh.length === 0
            ? "All of them are already saved."
            : `${fresh.length} not saved yet. Keep scrolling for more.`,
      ),
    );
    const saveAll = el("button", "btn btn-accent btn-full", "Save all on page");
    saveAll.type = "button";
    saveAll.disabled = fresh.length === 0;
    saveAll.addEventListener("click", () => saveAds(fresh));
    card.appendChild(saveAll);
    body.appendChild(card);

    renderSummary(body);
  };

  const renderSaved = (body) => {
    const saved = savedInSpace();
    body.appendChild(
      el("div", "section", `${saved.length} saved in this space`),
    );
    if (saved.length === 0) {
      body.appendChild(el("div", "empty", "Save an ad and it shows up here."));
      return;
    }
    body.appendChild(grid(saved.slice(0, 50)));
    if (saved.length > 50)
      body.appendChild(
        el(
          "div",
          "empty",
          "Showing the 50 most recent. Open the dashboard for all.",
        ),
      );
  };

  const renderLists = (body) => {
    const lists = activeLists();
    body.appendChild(el("div", "section", "Lists in this space"));
    body.appendChild(
      el("div", "empty", "Pick a list to make it the default for new saves."),
    );
    if (lists.length === 0) body.appendChild(el("div", "empty", "No lists yet."));
    for (const list of lists) {
      const isDefault = list.id === targets.defaultListId;
      const row = el(
        "button",
        "bubble row" + (isDefault ? " is-default" : ""),
      );
      row.type = "button";
      const dot = el("span", "dot");
      dot.style.background = list.color;
      row.append(
        dot,
        el("span", "row-name", list.name),
        el("span", "row-count", String(list.adIds.length)),
      );
      if (isDefault) row.append(el("span", "row-tag", "default"));
      row.addEventListener("click", async () => {
        await send({
          type: "SET_DEFAULT_LIST",
          listId: isDefault ? null : list.id,
        });
        await refreshAll();
        toast(isDefault ? "Default cleared" : `New saves go to ${list.name}`);
      });
      body.appendChild(row);
    }

    const add = el("button", "btn btn-full", "New list");
    add.type = "button";
    add.addEventListener("click", async () => {
      const name = prompt("List name:");
      if (!name) return;
      await send({ type: "LIST_OP", op: "create", name });
      await refreshAll();
    });
    body.appendChild(add);
  };

  const renderAccount = (body) => {
    const space = activeSpace();
    body.appendChild(el("div", "section", "Space"));
    const sel = el("select", "field");
    for (const s of targets.spaces) {
      const opt = el("option", null, s.name + (s.kind === "team" ? " (team)" : ""));
      opt.value = s.id;
      if (s.id === targets.activeSpaceId) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", async () => {
      await send({ type: "SPACE_OP", op: "activate", spaceId: sel.value });
      await refreshAll();
    });
    body.appendChild(sel);

    if (space && space.kind === "team") {
      const code = el("div", "bubble card");
      code.append(
        el("div", "card-sub", "Team join code"),
        el("div", "code", space.code),
        el(
          "div",
          "card-sub",
          "Teammates merge your exported space file to combine lists.",
        ),
      );
      body.appendChild(code);
    }

    body.appendChild(el("div", "section", "Appearance"));
    const themeRow = el("div", "bubble tabs");
    for (const [value, label] of [
      ["system", "Auto"],
      ["light", "Light"],
      ["dark", "Dark"],
    ]) {
      const b = el("button", "tab", label);
      b.type = "button";
      b.setAttribute("aria-selected", String(targets.theme === value));
      b.addEventListener("click", async () => {
        await send({ type: "SET_THEME", theme: value });
        await refreshAll();
      });
      themeRow.appendChild(b);
    }
    body.appendChild(themeRow);

    body.appendChild(el("div", "section", "Saved as"));
    body.appendChild(
      el("div", "empty", (store.identity && store.identity.displayName) || "Me"),
    );

    body.appendChild(el("div", "section", "Detection"));
    const diag = el("div", "bubble card");
    diag.append(
      el(
        "div",
        "card-sub",
        `${page.found} ad card${page.found === 1 ? "" : "s"} found on the page`,
      ),
      el("div", "card-sub", `${page.decorated} have Save / Download buttons`),
      el("div", "card-sub", `${page.matched} matched a captured record`),
    );
    body.appendChild(diag);

    body.appendChild(
      el(
        "div",
        "empty",
        "Team sharing, sync and export live in the full dashboard.",
      ),
    );
  };

  // ---------------------------------------------------------------------
  // Shell
  // ---------------------------------------------------------------------

  const ICONS = {
    home: '<path d="M3 9.5L10 4l7 5.5V16a1 1 0 01-1 1h-4v-4H8v4H4a1 1 0 01-1-1V9.5z"/>',
    saved: '<path d="M5 3h10a1 1 0 011 1v13l-6-3.5L4 17V4a1 1 0 011-1z"/>',
    lists: '<path d="M3 5h3v3H3V5zm5 .5h9v2H8v-2zM3 11h3v3H3v-3zm5 .5h9v2H8v-2z"/>',
    account:
      '<path d="M10 10a3.5 3.5 0 100-7 3.5 3.5 0 000 7zm0 1.8c-3.3 0-6 1.8-6 4v1.2h12V15.8c0-2.2-2.7-4-6-4z"/>',
  };

  const buildTabs = () => {
    const nav = $("#tabs");
    nav.innerHTML = "";
    for (const key of ["home", "saved", "lists", "account"]) {
      const b = el("button", "tab");
      b.type = "button";
      b.dataset.view = key;
      b.setAttribute("role", "tab");
      b.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true">${ICONS[key]}</svg><span>${
        key === "account" ? "Account" : key[0].toUpperCase() + key.slice(1)
      }</span>`;
      b.addEventListener("click", () => {
        view = key;
        render();
      });
      nav.appendChild(b);
    }
  };

  const prefersDark =
    typeof matchMedia === "function"
      ? matchMedia("(prefers-color-scheme: dark)")
      : null;

  const applyTheme = () => {
    const choice = targets.theme || "system";
    const dark =
      choice === "dark" ||
      (choice === "system" && !!(prefersDark && prefersDark.matches));
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  };

  if (prefersDark && prefersDark.addEventListener)
    prefersDark.addEventListener("change", applyTheme);

  const render = () => {
    applyTheme();

    const space = activeSpace();
    $("#head-sub").textContent = space
      ? space.name + (space.kind === "team" ? " · team" : "")
      : "Meta Ad Library";

    for (const b of document.querySelectorAll("#tabs .tab"))
      b.setAttribute("aria-selected", String(b.dataset.view === view));

    // The Ad Library button has no job once the tab is already there.
    $("#btn-library").hidden = page.onLibrary;

    const body = $("#view");
    body.innerHTML = "";
    if (view === "home") renderHome(body);
    else if (view === "saved") renderSaved(body);
    else if (view === "lists") renderLists(body);
    else renderAccount(body);
  };

  const refreshAll = async () => {
    const [t, s, p] = await Promise.all([
      send({ type: "GET_SAVE_TARGETS" }),
      send({ type: "GET_STATE" }),
      askPage(),
    ]);
    if (t.ok)
      targets = {
        spaces: t.spaces || [],
        lists: t.lists || [],
        activeSpaceId: t.activeSpaceId,
        defaultListId: t.defaultListId,
        theme: t.theme || "system",
      };
    if (s.ok) store = s;
    page = {
      ads: p.ads || [],
      onLibrary: !!p.onLibrary,
      found: p.found || 0,
      decorated: p.decorated || 0,
      matched: p.matched || 0,
    };
    render();
  };

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------

  buildTabs();
  $("#btn-dash").addEventListener("click", () =>
    send({ type: "OPEN_DASHBOARD" }),
  );
  $("#btn-library").addEventListener("click", () =>
    send({ type: "OPEN_LIBRARY" }),
  );
  refreshAll();

  // The panel outlives the tab it was opened over, so it has to follow the
  // user: a new active tab, a navigation, or a capture all change what "this
  // page" means.
  chrome.tabs.onActivated.addListener(() => refreshAll());
  chrome.tabs.onUpdated.addListener((_id, info, tab) => {
    if (info.status === "complete" && tab.active) refreshAll();
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "PAGE_ADS_CHANGED") refreshAll();
    return false;
  });
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === "local") refreshAll();
  });
})();
