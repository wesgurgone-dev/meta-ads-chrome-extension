/* Dashboard for saved Meta Ad Library ads: lists, stats, downloads, export. */
(() => {
  "use strict";

  const state = {
    ads: {},
    lists: {},
    activeList: "__all__", // '__all__' or a listId
    search: "",
    format: "",
    status: "",
    sort: "saved",
    selected: new Set(),
  };

  const $ = (sel) => document.querySelector(sel);
  const send = (msg) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError)
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(res || { ok: false });
      });
    });

  const escapeHtml = (s) =>
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

  const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString() : "-");
  const fmtNum = (n) => (n == null ? "-" : Number(n).toLocaleString());

  const daysRunning = (ad) => {
    if (!ad.startDate) return null;
    const end = ad.isActive === false && ad.endDate ? ad.endDate : Date.now();
    return Math.max(1, Math.round((end - ad.startDate) / 86400000));
  };

  const adFormat = (ad) => {
    const media = ad.media || [];
    if (
      media.filter((m) => m.type !== "video").length > 1 ||
      ad.displayFormat === "CAROUSEL"
    )
      return "carousel";
    if (media.some((m) => m.type === "video")) return "video";
    if (media.length > 0) return "image";
    return "text";
  };

  const thumbFor = (ad) => {
    if (ad.thumbDataUrl) return ad.thumbDataUrl;
    const m = (ad.media || []).find((x) => x.previewUrl) || (ad.media || [])[0];
    return (m && (m.previewUrl || (m.type === "image" ? m.url : null))) || null;
  };

  // -------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------

  const refresh = async () => {
    const res = await send({ type: "GET_STATE" });
    if (res.ok) {
      state.ads = res.ads || {};
      state.lists = res.lists || {};
    }
    for (const id of [...state.selected])
      if (!state.ads[id]) state.selected.delete(id);
    render();
  };

  const visibleAds = () => {
    let ads = Object.values(state.ads);
    if (state.activeList !== "__all__") {
      const list = state.lists[state.activeList];
      const ids = new Set(list ? list.adIds : []);
      ads = ads.filter((ad) => ids.has(ad.id));
    }
    if (state.format) ads = ads.filter((ad) => adFormat(ad) === state.format);
    if (state.status === "active")
      ads = ads.filter((ad) => ad.isActive === true);
    if (state.status === "inactive")
      ads = ads.filter((ad) => ad.isActive === false);
    if (state.search) {
      const q = state.search.toLowerCase();
      ads = ads.filter((ad) =>
        [
          ad.pageName,
          ad.body,
          ad.title,
          ad.ctaText,
          ad.linkUrl,
          ad.byline,
          ad.id,
        ]
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
      reach: (a, b) => (b.euTotalReach || 0) - (a.euTotalReach || 0),
    };
    return ads.sort(sorters[state.sort] || sorters.saved);
  };

  // -------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------

  const render = () => {
    renderSidebar();
    const ads = visibleAds();
    renderStats(ads);
    renderGrid(ads);
    renderBulkbar();
  };

  const renderSidebar = () => {
    $("#count-all").textContent = String(Object.keys(state.ads).length);
    const wrap = $("#user-lists");
    wrap.innerHTML = "";
    const lists = Object.values(state.lists).sort(
      (a, b) => a.createdAt - b.createdAt,
    );
    for (const list of lists) {
      const btn = document.createElement("button");
      btn.className =
        "nav-item" + (state.activeList === list.id ? " active" : "");
      btn.dataset.list = list.id;
      btn.innerHTML = `
        <span>${escapeHtml(list.name)}</span>
        <span style="display:flex;align-items:center;gap:6px">
          <span class="nav-count">${list.adIds.length}</span>
          <span class="nav-x" title="Delete list">✕</span>
        </span>`;
      btn.addEventListener("click", (e) => {
        if (e.target.classList.contains("nav-x")) {
          e.stopPropagation();
          deleteList(list);
          return;
        }
        state.activeList = list.id;
        state.selected.clear();
        render();
      });
      btn.addEventListener("dblclick", () => renameList(list));
      wrap.appendChild(btn);
    }
    document
      .querySelector('.nav-item[data-list="__all__"]')
      .classList.toggle("active", state.activeList === "__all__");
  };

  const renderStats = (ads) => {
    const advertisers = new Set(ads.map((a) => a.pageId || a.pageName)).size;
    const active = ads.filter((a) => a.isActive === true).length;
    const days = ads.map(daysRunning).filter((d) => d != null);
    const avgDays = days.length
      ? Math.round(days.reduce((s, d) => s + d, 0) / days.length)
      : null;
    const euReach = ads.reduce((s, a) => s + (a.euTotalReach || 0), 0);
    const withSpend = ads.filter((a) => a.spend).length;
    const stats = [
      { label: "Ads in view", value: fmtNum(ads.length) },
      { label: "Advertisers", value: fmtNum(advertisers) },
      { label: "Active now", value: fmtNum(active) },
      {
        label: "Avg days running",
        value: avgDays == null ? "-" : fmtNum(avgDays),
      },
      { label: "EU reach (total)", value: euReach ? fmtNum(euReach) : "-" },
      { label: "With spend data", value: fmtNum(withSpend) },
    ];
    $("#stats").innerHTML = stats
      .map(
        (s) => `<div class="stat"><div class="stat-value">${s.value}</div>
                <div class="stat-label">${s.label}</div></div>`,
      )
      .join("");
  };

  const renderGrid = (ads) => {
    const grid = $("#grid");
    $("#empty").classList.toggle("hidden", ads.length > 0);
    grid.innerHTML = "";
    for (const ad of ads) grid.appendChild(buildCard(ad));
  };

  const buildCard = (ad) => {
    const card = document.createElement("div");
    card.className = "card" + (state.selected.has(ad.id) ? " selected" : "");
    const thumb = thumbFor(ad);
    const format = adFormat(ad);
    const days = daysRunning(ad);

    const chips = [];
    if (days != null)
      chips.push(
        `<span class="chip ${days >= 30 ? "hot" : ""}">${days}d running</span>`,
      );
    if (ad.spend)
      chips.push(
        `<span class="chip money">Spend: ${escapeHtml(ad.spend)}${ad.currency ? " " + escapeHtml(ad.currency) : ""}</span>`,
      );
    if (ad.impressionsText)
      chips.push(
        `<span class="chip money">Impr: ${escapeHtml(ad.impressionsText)}</span>`,
      );
    if (ad.euTotalReach)
      chips.push(
        `<span class="chip">EU reach ${fmtNum(ad.euTotalReach)}</span>`,
      );
    for (const p of (ad.platforms || []).slice(0, 4))
      chips.push(
        `<span class="chip">${escapeHtml(String(p).toLowerCase())}</span>`,
      );
    if (ad.ctaText)
      chips.push(`<span class="chip">CTA: ${escapeHtml(ad.ctaText)}</span>`);

    card.innerHTML = `
      <input type="checkbox" class="card-check" ${state.selected.has(ad.id) ? "checked" : ""} />
      <div class="card-media">
        ${
          thumb
            ? `<img src="${escapeHtml(thumb)}" loading="lazy" alt="" />`
            : `<div class="media-placeholder">${format === "text" ? "Aa" : "▲"}</div>`
        }
        ${
          ad.isActive === true
            ? '<span class="badge active-badge">ACTIVE</span>'
            : ad.isActive === false
              ? '<span class="badge inactive-badge">ENDED</span>'
              : ""
        }
        <span class="badge">${format.toUpperCase()}</span>
      </div>
      <div class="card-body">
        <div class="card-advertiser">
          ${ad.pageProfilePictureUrl ? `<img src="${escapeHtml(ad.pageProfilePictureUrl)}" alt="" />` : ""}
          <span>${escapeHtml(ad.pageName || "Unknown page")}</span>
        </div>
        <div class="card-meta">${fmtDate(ad.startDate)}${ad.endDate ? " → " + fmtDate(ad.endDate) : ""} · ID ${escapeHtml(ad.id)}</div>
        <div class="chips">${chips.join("")}</div>
        ${ad.body ? `<div class="card-copy">${escapeHtml(ad.body)}</div>` : ""}
        <div class="card-actions">
          <button class="btn btn-ghost act-details" type="button">Details</button>
          <button class="btn btn-green act-download" type="button">Download</button>
        </div>
      </div>`;

    card.querySelector(".card-check").addEventListener("change", (e) => {
      if (e.target.checked) state.selected.add(ad.id);
      else state.selected.delete(ad.id);
      card.classList.toggle("selected", e.target.checked);
      renderBulkbar();
    });
    card
      .querySelector(".card-media")
      .addEventListener("click", () => openModal(ad));
    card
      .querySelector(".act-details")
      .addEventListener("click", () => openModal(ad));
    card.querySelector(".act-download").addEventListener("click", async (e) => {
      const btn = e.target;
      btn.disabled = true;
      const res = await send({ type: "DOWNLOAD_AD", ad });
      btn.disabled = false;
      btn.textContent = res.ok ? `Got ${res.count} ✓` : "Failed";
      setTimeout(() => (btn.textContent = "Download"), 2000);
    });
    return card;
  };

  // -------------------------------------------------------------------
  // Detail modal
  // -------------------------------------------------------------------

  const openModal = (ad) => {
    const rows = [
      ["Advertiser", ad.pageName],
      ["Page ID", ad.pageId],
      ["Library ID", ad.id],
      [
        "Status",
        ad.isActive === true
          ? "Active"
          : ad.isActive === false
            ? "Ended"
            : "Unknown",
      ],
      ["Started", fmtDate(ad.startDate)],
      ["Ended", ad.endDate ? fmtDate(ad.endDate) : "-"],
      ["Days running", daysRunning(ad)],
      ["Platforms", (ad.platforms || []).join(", ")],
      ["Format", adFormat(ad)],
      ["Variations (collation)", ad.collationCount],
      ["Spend", ad.spend ? `${ad.spend} ${ad.currency || ""}` : null],
      ["Impressions", ad.impressionsText],
      [
        "EU total reach",
        ad.euTotalReach != null ? fmtNum(ad.euTotalReach) : null,
      ],
      ["Reach estimate", ad.reachEstimate],
      ["Funding / byline", ad.byline],
      [
        "Payer / beneficiary",
        ad.payerBeneficiary ? JSON.stringify(ad.payerBeneficiary) : null,
      ],
      ["Target ages", ad.targetAges],
      ["Gender audience", ad.genderAudience],
      ["Title", ad.title],
      ["Body", ad.body],
      ["Link description", ad.linkDescription],
      [
        "CTA",
        ad.ctaText
          ? `${ad.ctaText}${ad.ctaType ? ` (${ad.ctaType})` : ""}`
          : null,
      ],
      ["Destination", ad.linkUrl],
      [
        "Page likes",
        ad.pageLikeCount != null ? fmtNum(ad.pageLikeCount) : null,
      ],
      [
        "Page categories",
        Array.isArray(ad.pageCategories)
          ? ad.pageCategories.join(", ")
          : ad.pageCategories,
      ],
      ["Saved", ad.savedAt ? new Date(ad.savedAt).toLocaleString() : null],
    ].filter(([, v]) => v != null && v !== "");

    const mediaHtml = (ad.media || [])
      .map((m) => {
        if (m.type === "video") {
          const src = m.hdUrl || m.sdUrl || m.url;
          return `<video controls preload="metadata" ${m.previewUrl ? `poster="${escapeHtml(m.previewUrl)}"` : ""}>
                    <source src="${escapeHtml(src)}" /></video>`;
        }
        return `<img src="${escapeHtml(m.url)}" alt="" />`;
      })
      .join("");

    $("#modal-card").innerHTML = `
      <button class="modal-close" type="button">✕</button>
      <h2 style="margin:0 0 4px">${escapeHtml(ad.pageName || "Unknown page")}</h2>
      <a href="${escapeHtml(ad.libraryUrl)}" target="_blank" rel="noreferrer">Open in Meta Ad Library ↗</a>
      ${ad.linkUrl ? ` · <a href="${escapeHtml(ad.linkUrl)}" target="_blank" rel="noreferrer">Landing page ↗</a>` : ""}
      <div class="modal-media">${mediaHtml || '<div class="note">No media captured.</div>'}</div>
      <table class="detail-table">${rows
        .map(
          ([k, v]) =>
            `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`,
        )
        .join("")}</table>
      <p class="note">Meta only publishes spend and impression ranges for political/social-issue ads,
      and audience/reach data for ads shown in the EU. Days running and active status are the best
      public efficacy proxies for regular commercial ads: advertisers keep winners live.</p>`;

    $("#modal").classList.remove("hidden");
    $("#modal-card .modal-close").addEventListener("click", closeModal);
  };

  const closeModal = () => $("#modal").classList.add("hidden");

  // -------------------------------------------------------------------
  // Lists
  // -------------------------------------------------------------------

  const createList = async () => {
    const name = prompt("List name:");
    if (!name) return;
    const res = await send({ type: "LIST_OP", op: "create", name });
    if (res.ok) {
      state.activeList = res.list.id;
      await refresh();
    }
  };

  const renameList = async (list) => {
    const name = prompt("Rename list:", list.name);
    if (!name || name === list.name) return;
    await send({ type: "LIST_OP", op: "rename", listId: list.id, name });
    await refresh();
  };

  const deleteList = async (list) => {
    if (!confirm(`Delete list "${list.name}"? Saved ads stay in your library.`))
      return;
    await send({ type: "LIST_OP", op: "delete", listId: list.id });
    if (state.activeList === list.id) state.activeList = "__all__";
    await refresh();
  };

  // -------------------------------------------------------------------
  // Bulk actions
  // -------------------------------------------------------------------

  const renderBulkbar = () => {
    const bar = $("#bulkbar");
    bar.classList.toggle("hidden", state.selected.size === 0);
    $("#bulk-count").textContent = `${state.selected.size} selected`;
    const target = $("#bulk-list-target");
    target.innerHTML = Object.values(state.lists)
      .map(
        (l) =>
          `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`,
      )
      .join("");
    target.disabled = target.options.length === 0;
    $("#bulk-remove").textContent =
      state.activeList === "__all__"
        ? "Delete from library"
        : "Remove from list";
  };

  const bulkAdd = async () => {
    const listId = $("#bulk-list-target").value;
    if (!listId) {
      alert("Create a list first.");
      return;
    }
    await send({
      type: "LIST_OP",
      op: "add_ads",
      listId,
      adIds: [...state.selected],
    });
    state.selected.clear();
    await refresh();
  };

  const bulkDownload = async () => {
    for (const id of state.selected) {
      const ad = state.ads[id];
      if (ad) await send({ type: "DOWNLOAD_AD", ad });
    }
  };

  const bulkRemove = async () => {
    const ids = [...state.selected];
    if (state.activeList === "__all__") {
      if (
        !confirm(
          `Delete ${ids.length} ad(s) from your library? This also removes them from lists.`,
        )
      )
        return;
      await send({ type: "DELETE_ADS", adIds: ids });
    } else {
      await send({
        type: "LIST_OP",
        op: "remove_ads",
        listId: state.activeList,
        adIds: ids,
      });
    }
    state.selected.clear();
    await refresh();
  };

  // -------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------

  const downloadBlob = (content, filename, mime) => {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const exportJson = () => {
    const ads = visibleAds();
    downloadBlob(
      JSON.stringify(ads, null, 2),
      `meta-ads-export-${Date.now()}.json`,
      "application/json",
    );
  };

  const exportCsv = () => {
    const ads = visibleAds();
    const cols = [
      "id",
      "pageName",
      "pageId",
      "isActive",
      "startDate",
      "endDate",
      "daysRunning",
      "platforms",
      "format",
      "spend",
      "currency",
      "impressionsText",
      "euTotalReach",
      "byline",
      "collationCount",
      "title",
      "body",
      "ctaText",
      "linkUrl",
      "libraryUrl",
    ];
    const cell = (v) =>
      `"${String(v ?? "")
        .replace(/"/g, '""')
        .replace(/\r?\n/g, " ")}"`;
    const lines = [cols.join(",")];
    for (const ad of ads) {
      lines.push(
        cols
          .map((c) => {
            if (c === "daysRunning") return cell(daysRunning(ad));
            if (c === "format") return cell(adFormat(ad));
            if (c === "platforms") return cell((ad.platforms || []).join("|"));
            if (c === "startDate" || c === "endDate")
              return cell(
                ad[c] ? new Date(ad[c]).toISOString().slice(0, 10) : "",
              );
            return cell(ad[c]);
          })
          .join(","),
      );
    }
    downloadBlob(
      lines.join("\n"),
      `meta-ads-export-${Date.now()}.csv`,
      "text/csv",
    );
  };

  // -------------------------------------------------------------------
  // Wire up
  // -------------------------------------------------------------------

  $("#search").addEventListener("input", (e) => {
    state.search = e.target.value.trim();
    render();
  });
  $("#filter-format").addEventListener("change", (e) => {
    state.format = e.target.value;
    render();
  });
  $("#filter-status").addEventListener("change", (e) => {
    state.status = e.target.value;
    render();
  });
  $("#sort").addEventListener("change", (e) => {
    state.sort = e.target.value;
    render();
  });
  document
    .querySelector('.nav-item[data-list="__all__"]')
    .addEventListener("click", () => {
      state.activeList = "__all__";
      state.selected.clear();
      render();
    });
  $("#btn-new-list").addEventListener("click", createList);
  $("#btn-export-json").addEventListener("click", exportJson);
  $("#btn-export-csv").addEventListener("click", exportCsv);
  $("#bulk-add").addEventListener("click", bulkAdd);
  $("#bulk-download").addEventListener("click", bulkDownload);
  $("#bulk-remove").addEventListener("click", bulkRemove);
  $("#bulk-clear").addEventListener("click", () => {
    state.selected.clear();
    render();
  });
  $("#modal .modal-backdrop").addEventListener("click", closeModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.ads || changes.lists)) refresh();
  });

  refresh();
})();
