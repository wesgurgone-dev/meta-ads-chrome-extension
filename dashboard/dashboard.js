/* Dashboard: spaces, colour-coded lists, metrics, team sharing, sync. */
(() => {
  "use strict";

  const M = globalThis.MalMetrics;

  const LIST_COLORS = [
    "#2a78d6",
    "#eb6834",
    "#1baf7a",
    "#eda100",
    "#e87ba4",
    "#008300",
    "#4a3aa7",
    "#e34948",
  ];

  const state = {
    spaces: {},
    lists: {},
    ads: {},
    settings: {},
    identity: {},
    activeList: "__all__",
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
  const daysRunning = (ad) => M.daysRunning(ad);
  const adFormat = (ad) => M.adFormat(ad);

  const activeSpaceId = () => state.settings.activeSpaceId;
  const activeSpace = () => state.spaces[activeSpaceId()] || null;
  const spaceLists = () =>
    Object.values(state.lists)
      .filter((l) => l.spaceId === activeSpaceId())
      .sort((a, b) => a.createdAt - b.createdAt);

  const thumbFor = (ad) => {
    if (ad.thumbDataUrl) return ad.thumbDataUrl;
    const m = (ad.media || []).find((x) => x.previewUrl) || (ad.media || [])[0];
    return (m && (m.previewUrl || (m.type === "image" ? m.url : null))) || null;
  };

  /** Lists (in the active space) an ad belongs to, for its colour chips. */
  const listsForAd = (adId) =>
    spaceLists().filter((l) => l.adIds.includes(adId));

  // -------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------

  const refresh = async () => {
    const res = await send({ type: "GET_STATE" });
    if (res.ok) {
      state.spaces = res.spaces || {};
      state.lists = res.lists || {};
      state.ads = res.ads || {};
      state.settings = res.settings || {};
      state.identity = res.identity || {};
    }
    if (state.activeList !== "__all__" && !state.lists[state.activeList])
      state.activeList = "__all__";
    for (const id of [...state.selected])
      if (!state.ads[id]) state.selected.delete(id);
    render();
  };

  const visibleAds = () => {
    const lists = spaceLists();
    let ids;
    if (state.activeList === "__all__") {
      ids = new Set();
      for (const l of lists) for (const id of l.adIds) ids.add(id);
    } else {
      ids = new Set((state.lists[state.activeList] || { adIds: [] }).adIds);
    }

    let ads = [...ids].map((id) => state.ads[id]).filter(Boolean);

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
          ad.savedBy,
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
    };
    return ads.sort(sorters[state.sort] || sorters.saved);
  };

  // -------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------

  const render = () => {
    renderSpaces();
    renderSidebar();
    const ads = visibleAds();
    const agg = M.aggregate(ads);
    renderStats(agg);
    renderMetrics(agg);
    renderGrid(ads);
    renderBulkbar();
  };

  const renderSpaces = () => {
    const sel = $("#space-select");
    const spaces = Object.values(state.spaces).sort(
      (a, b) => a.createdAt - b.createdAt,
    );
    sel.innerHTML = spaces
      .map(
        (s) =>
          `<option value="${escapeHtml(s.id)}"${s.id === activeSpaceId() ? " selected" : ""}>${escapeHtml(s.name)}${s.kind === "team" ? " (team)" : ""}</option>`,
      )
      .join("");

    const space = activeSpace();
    const meta = $("#space-meta");
    if (space && space.kind === "team") {
      meta.innerHTML = `Join code <span class="space-code">${escapeHtml(space.code)}</span>`;
    } else {
      meta.textContent = "Personal space, private to this browser.";
    }
  };

  const renderSidebar = () => {
    const lists = spaceLists();
    const all = new Set();
    for (const l of lists) for (const id of l.adIds) all.add(id);
    $("#count-all").textContent = String(all.size);

    const wrap = $("#user-lists");
    wrap.innerHTML = "";
    for (const list of lists) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "nav-item" + (state.activeList === list.id ? " active" : "");
      btn.innerHTML = `
        <span class="nav-dot" style="background:${escapeHtml(list.color)}"></span>
        <span class="nav-name"></span>
        <span class="nav-count">${list.adIds.length}</span>
        <span class="nav-menu" title="List options">&#8942;</span>`;
      btn.querySelector(".nav-name").textContent = list.name;
      btn.addEventListener("click", (e) => {
        if (e.target.classList.contains("nav-menu")) {
          e.stopPropagation();
          openListModal(list);
          return;
        }
        state.activeList = list.id;
        state.selected.clear();
        render();
      });
      wrap.appendChild(btn);
    }
    document
      .querySelector('.nav-item[data-list="__all__"]')
      .classList.toggle("active", state.activeList === "__all__");
  };

  const renderStats = (agg) => {
    const space = activeSpace();
    const tiles = [
      { label: "Ads in view", value: fmtNum(agg.total) },
      { label: "Advertisers", value: fmtNum(agg.advertiserCount) },
      { label: "Active now", value: fmtNum(agg.active) },
      {
        label: "Running 30d+",
        value: fmtNum(agg.longRunners),
        note: "the public winner signal",
      },
      {
        label: "Avg days running",
        value: agg.avgDaysRunning == null ? "-" : fmtNum(agg.avgDaysRunning),
        note: agg.maxDaysRunning
          ? `longest ${fmtNum(agg.maxDaysRunning)}d`
          : "",
      },
      {
        label: "Saved this week",
        value: fmtNum(agg.saves.week),
        note: `${agg.saves.today} today · ${agg.saves.month} in 30d`,
      },
    ];
    if (space && space.kind === "team") {
      tiles.push({
        label: "Contributors",
        value: fmtNum(agg.contributors.rows.length),
        note: agg.contributors.rows.length
          ? `top: ${agg.contributors.rows[0].label}`
          : "",
      });
    }

    $("#stats").innerHTML = tiles
      .map(
        (s) => `<div class="stat">
          <div class="stat-value">${escapeHtml(s.value)}</div>
          <div class="stat-label">${escapeHtml(s.label)}</div>
          ${s.note ? `<div class="stat-note">${escapeHtml(s.note)}</div>` : ""}
        </div>`,
      )
      .join("");
  };

  // -------------------------------------------------------------------
  // Charts
  // -------------------------------------------------------------------

  const tip = (() => {
    let el = null;
    return {
      show(e, html) {
        if (!el) {
          el = document.createElement("div");
          el.id = "viz-tip";
          document.body.appendChild(el);
        }
        el.innerHTML = html;
        el.classList.add("visible");
        const pad = 12;
        const rect = el.getBoundingClientRect();
        let x = e.clientX + pad;
        if (x + rect.width > window.innerWidth - pad)
          x = e.clientX - rect.width - pad;
        el.style.left = `${Math.max(pad, x)}px`;
        el.style.top = `${Math.max(pad, e.clientY - rect.height - pad)}px`;
      },
      hide() {
        if (el) el.classList.remove("visible");
      },
    };
  })();

  const attachTip = (node, html) => {
    node.addEventListener("mousemove", (e) => tip.show(e, html));
    node.addEventListener("mouseleave", () => tip.hide());
  };

  const barChart = (title, sub, rows, footer) => {
    const wrap = document.createElement("div");
    wrap.className = "viz";
    wrap.innerHTML = `<div class="viz-title">${escapeHtml(title)}</div>
      <div class="viz-sub">${escapeHtml(sub)}</div>`;
    if (rows.length === 0) {
      wrap.insertAdjacentHTML(
        "beforeend",
        '<div class="viz-empty">No data yet.</div>',
      );
      return wrap;
    }
    const max = Math.max(...rows.map((r) => r.value), 1);
    for (const row of rows) {
      const el = document.createElement("div");
      el.className = "bar-row";
      el.innerHTML = `
        <div class="bar-label"></div>
        <div class="bar-track"><div class="bar-fill" style="width:${(row.value / max) * 100}%"></div></div>
        <div class="bar-value">${escapeHtml(M.compact(row.value))}</div>`;
      const label = el.querySelector(".bar-label");
      label.textContent = row.label;
      label.title = row.label;
      attachTip(
        el,
        `<strong>${escapeHtml(row.label)}</strong><br>${fmtNum(row.value)} ad${row.value === 1 ? "" : "s"}`,
      );
      wrap.appendChild(el);
    }
    if (footer)
      wrap.insertAdjacentHTML(
        "beforeend",
        `<div class="viz-sub" style="margin-top:8px">${escapeHtml(footer)}</div>`,
      );
    return wrap;
  };

  const savesChart = (timeline) => {
    const wrap = document.createElement("div");
    wrap.className = "viz";
    const total = timeline.reduce((s, d) => s + d.value, 0);
    wrap.innerHTML = `<div class="viz-title">Saves per day</div>
      <div class="viz-sub">${fmtNum(total)} saved in the last 30 days</div>`;
    const chart = document.createElement("div");
    chart.className = "col-chart";
    const max = Math.max(...timeline.map((d) => d.value), 1);
    for (const d of timeline) {
      const slot = document.createElement("div");
      slot.className = "col-slot";
      const h = d.value === 0 ? 2 : Math.max(4, (d.value / max) * 88);
      slot.innerHTML = `<div class="col-fill${d.value === 0 ? " zero" : ""}" style="height:${h}px"></div>`;
      attachTip(
        slot,
        `<strong>${new Date(d.ms).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</strong><br>${fmtNum(d.value)} saved`,
      );
      chart.appendChild(slot);
    }
    wrap.appendChild(chart);
    const fmtTick = (ms) =>
      new Date(ms).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });
    wrap.insertAdjacentHTML(
      "beforeend",
      `<div class="col-axis"><span>${escapeHtml(fmtTick(timeline[0].ms))}</span><span>${escapeHtml(fmtTick(timeline[timeline.length - 1].ms))}</span></div>`,
    );
    return wrap;
  };

  const stackChart = (title, sub, rows) => {
    const wrap = document.createElement("div");
    wrap.className = "viz";
    wrap.innerHTML = `<div class="viz-title">${escapeHtml(title)}</div>
      <div class="viz-sub">${escapeHtml(sub)}</div>`;
    const total = rows.reduce((s, r) => s + r.value, 0);
    if (total === 0) {
      wrap.insertAdjacentHTML(
        "beforeend",
        '<div class="viz-empty">No data yet.</div>',
      );
      return wrap;
    }
    const stack = document.createElement("div");
    stack.className = "stack";
    rows.forEach((row, i) => {
      if (row.value === 0) return;
      const seg = document.createElement("div");
      seg.className = "stack-seg";
      seg.style.flex = String(row.value);
      seg.style.background = `var(--series-${i + 1})`;
      attachTip(
        seg,
        `<strong>${escapeHtml(row.label)}</strong><br>${fmtNum(row.value)} ads · ${Math.round((row.value / total) * 100)}%`,
      );
      stack.appendChild(seg);
    });
    wrap.appendChild(stack);
    // Legend carries identity and values, so colour is never the only cue.
    wrap.insertAdjacentHTML(
      "beforeend",
      `<div class="legend">${rows
        .map(
          (row, i) =>
            `<span class="legend-item">
               <span class="legend-dot" style="background:var(--series-${i + 1})"></span>
               ${escapeHtml(row.label)}
               <span class="legend-value">${fmtNum(row.value)}</span>
             </span>`,
        )
        .join("")}</div>`,
    );
    return wrap;
  };

  const renderMetrics = (agg) => {
    const body = $("#metrics-body");
    body.innerHTML = "";
    if (agg.total === 0) {
      body.innerHTML =
        '<div class="viz-empty">Save some ads to see metrics.</div>';
      return;
    }
    body.appendChild(savesChart(agg.saves.timeline));
    body.appendChild(
      barChart(
        "Top advertisers",
        "saved ads per advertiser",
        agg.advertisers.rows,
        agg.advertisers.otherCount
          ? `+ ${agg.advertisers.otherCount} more (${agg.advertisers.otherValue} ads)`
          : "",
      ),
    );
    body.appendChild(
      stackChart("Format mix", "share of saved ads by creative type", [
        { label: "Video", value: agg.formatCounts.video },
        { label: "Image", value: agg.formatCounts.image },
        { label: "Carousel", value: agg.formatCounts.carousel },
        { label: "Text only", value: agg.formatCounts.text },
      ]),
    );
    body.appendChild(
      barChart(
        "Placements",
        "ads running on each platform",
        agg.platformCounts.rows,
        "",
      ),
    );
    const space = activeSpace();
    if (space && space.kind === "team" && agg.contributors.rows.length) {
      body.appendChild(
        barChart(
          "Contributors",
          "ads saved by each teammate",
          agg.contributors.rows,
          "",
        ),
      );
    }
  };

  // -------------------------------------------------------------------
  // Grid
  // -------------------------------------------------------------------

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
    for (const list of listsForAd(ad.id)) {
      chips.push(
        `<span class="chip list-chip"><span class="legend-dot" style="background:${escapeHtml(list.color)}"></span>${escapeHtml(list.name)}</span>`,
      );
    }
    if (days != null)
      chips.push(
        `<span class="chip ${days >= 30 ? "hot" : ""}">${days}d running</span>`,
      );
    for (const p of (ad.platforms || []).slice(0, 3))
      chips.push(
        `<span class="chip">${escapeHtml(String(p).toLowerCase())}</span>`,
      );
    if (ad.ctaText)
      chips.push(`<span class="chip">${escapeHtml(ad.ctaText)}</span>`);

    card.innerHTML = `
      <input type="checkbox" class="card-check" ${state.selected.has(ad.id) ? "checked" : ""} />
      <div class="card-media">
        ${
          thumb
            ? `<img src="${escapeHtml(thumb)}" loading="lazy" alt="" />`
            : `<div class="media-placeholder">${escapeHtml(format)}</div>`
        }
        ${
          ad.isActive === true
            ? '<span class="badge active-badge">ACTIVE</span>'
            : ad.isActive === false
              ? '<span class="badge inactive-badge">ENDED</span>'
              : ""
        }
        <span class="badge">${escapeHtml(format.toUpperCase())}</span>
      </div>
      <div class="card-body">
        <div class="card-advertiser">
          ${ad.pageProfilePictureUrl ? `<img src="${escapeHtml(ad.pageProfilePictureUrl)}" alt="" />` : ""}
          <span class="adv-name"></span>
        </div>
        <div class="card-meta">${escapeHtml(fmtDate(ad.startDate))}${ad.endDate ? " → " + escapeHtml(fmtDate(ad.endDate)) : ""}${ad.savedBy ? " · by " + escapeHtml(ad.savedBy) : ""}</div>
        <div class="chips">${chips.join("")}</div>
        ${ad.body ? '<div class="card-copy"></div>' : ""}
        <div class="card-actions">
          <button class="btn btn-ghost act-details" type="button">Details</button>
          <button class="btn btn-green act-download" type="button">Download</button>
        </div>
      </div>`;

    card.querySelector(".adv-name").textContent = ad.pageName || "Unknown page";
    const copy = card.querySelector(".card-copy");
    if (copy) copy.textContent = ad.body;

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
      btn.textContent = res.ok ? `Got ${res.count}` : "Failed";
      setTimeout(() => (btn.textContent = "Download"), 2000);
    });
    return card;
  };

  // -------------------------------------------------------------------
  // Modals
  // -------------------------------------------------------------------

  const showModal = (html, wire) => {
    $("#modal-card").innerHTML =
      `<button class="modal-close" type="button">&#10005;</button>${html}`;
    $("#modal").classList.remove("hidden");
    $("#modal-card .modal-close").addEventListener("click", closeModal);
    if (wire) wire($("#modal-card"));
  };

  const closeModal = () => $("#modal").classList.add("hidden");

  const openModal = (ad) => {
    const rows = [
      ["Advertiser", ad.pageName],
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
      ["Variations", ad.collationCount],
      ["Title", ad.title],
      ["Body", ad.body],
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
      ["Saved by", ad.savedBy],
      ["Saved", ad.savedAt ? new Date(ad.savedAt).toLocaleString() : null],
      // Disclosure-only fields: shown when Meta published them, never as a
      // permanent "not disclosed" row for ordinary commercial ads.
      [
        "Spend (disclosed)",
        ad.spend ? `${ad.spend} ${ad.currency || ""}` : null,
      ],
      ["Impressions (disclosed)", ad.impressionsText],
      [
        "EU reach (disclosed)",
        ad.euTotalReach != null ? fmtNum(ad.euTotalReach) : null,
      ],
    ].filter(([, v]) => v != null && v !== "");

    const media = (ad.media || [])
      .map((m) =>
        m.type === "video"
          ? `<video controls preload="metadata" ${m.previewUrl ? `poster="${escapeHtml(m.previewUrl)}"` : ""}><source src="${escapeHtml(m.hdUrl || m.sdUrl || m.url)}" /></video>`
          : `<img src="${escapeHtml(m.url)}" alt="" />`,
      )
      .join("");

    showModal(`
      <h2>${escapeHtml(ad.pageName || "Unknown page")}</h2>
      <p><a href="${escapeHtml(ad.libraryUrl)}" target="_blank" rel="noreferrer">Open in Meta Ad Library</a>${
        ad.linkUrl
          ? ` · <a href="${escapeHtml(ad.linkUrl)}" target="_blank" rel="noreferrer">Landing page</a>`
          : ""
      }</p>
      <div class="modal-media">${media || '<div class="note">No media captured. Synced ads carry no media URLs, since Meta\'s signed links expire.</div>'}</div>
      <table class="detail-table">${rows
        .map(
          ([k, v]) =>
            `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`,
        )
        .join("")}</table>`);
  };

  const colorSwatches = (selected) =>
    `<div class="swatches">${LIST_COLORS.map(
      (c) =>
        `<button type="button" class="swatch${c === selected ? " selected" : ""}" data-color="${c}" style="background:${c}" aria-label="${c}"></button>`,
    ).join("")}</div>`;

  const openListModal = (list) => {
    showModal(
      `<h2>List settings</h2>
       <div class="form-row">
         <label class="field-label" for="list-name">Name</label>
         <input type="text" id="list-name" value="${escapeHtml(list.name)}" />
       </div>
       <div class="form-row">
         <label class="field-label">Label colour</label>
         ${colorSwatches(list.color)}
       </div>
       <div class="modal-actions">
         <button class="btn btn-primary" id="list-save" type="button">Save</button>
         <button class="btn btn-danger" id="list-delete" type="button">Delete list</button>
       </div>
       <p class="note">Deleting a list keeps its ads in the space if they are also in another list.</p>`,
      (root) => {
        let color = list.color;
        root.querySelectorAll(".swatch").forEach((sw) => {
          sw.addEventListener("click", () => {
            color = sw.dataset.color;
            root
              .querySelectorAll(".swatch")
              .forEach((s) => s.classList.remove("selected"));
            sw.classList.add("selected");
          });
        });
        root.querySelector("#list-save").addEventListener("click", async () => {
          const name = root.querySelector("#list-name").value.trim();
          if (name && name !== list.name)
            await send({
              type: "LIST_OP",
              op: "rename",
              listId: list.id,
              name,
            });
          if (color !== list.color)
            await send({
              type: "LIST_OP",
              op: "recolor",
              listId: list.id,
              color,
            });
          closeModal();
          refresh();
        });
        root
          .querySelector("#list-delete")
          .addEventListener("click", async () => {
            if (!confirm(`Delete the list "${list.name}"?`)) return;
            await send({ type: "LIST_OP", op: "delete", listId: list.id });
            if (state.activeList === list.id) state.activeList = "__all__";
            closeModal();
            refresh();
          });
      },
    );
  };

  const openTeamModal = () => {
    const space = activeSpace();
    const isTeam = space && space.kind === "team";
    showModal(
      `<h2>Team spaces</h2>
       ${
         isTeam
           ? `<p>Share this code and the space file so teammates can merge their saves into
              <strong>${escapeHtml(space.name)}</strong>.</p>
              <div class="code-display">${escapeHtml(space.code)}</div>`
           : `<p><strong>${escapeHtml(space && space.name)}</strong> is a personal space.
              Create a team space to collect a shared swipe file.</p>`
       }
       <div class="modal-actions">
         ${isTeam ? '<button class="btn btn-primary" id="team-export" type="button">Export space file</button>' : ""}
         <button class="btn btn-ghost" id="team-import" type="button">Join / merge from file</button>
         ${isTeam ? "" : '<button class="btn btn-primary" id="team-create" type="button">Create team space</button>'}
       </div>
       <p class="note">
         Sharing works by exporting a space file that teammates import: everyone's lists merge
         into one space, matched on the join code. It needs no server and no accounts, but it is
         a snapshot, so re-export after adding ads. Live sync between teammates would need a
         hosted backend.
       </p>`,
      (root) => {
        const exportBtn = root.querySelector("#team-export");
        if (exportBtn)
          exportBtn.addEventListener("click", async () => {
            const res = await send({ type: "EXPORT_SPACE", spaceId: space.id });
            if (!res.ok) return;
            downloadBlob(
              JSON.stringify(res.payload, null, 2),
              `${space.name.replace(/\s+/g, "-").toLowerCase()}-${space.code}.json`,
              "application/json",
            );
          });

        root.querySelector("#team-import").addEventListener("click", () => {
          $("#import-file").click();
        });

        const createBtn = root.querySelector("#team-create");
        if (createBtn)
          createBtn.addEventListener("click", async () => {
            const name = prompt("Name this team space:", "Team swipe file");
            if (!name) return;
            await send({ type: "SPACE_OP", op: "create", kind: "team", name });
            closeModal();
            state.activeList = "__all__";
            refresh();
          });
      },
    );
  };

  const openSettingsModal = async () => {
    const status = await send({ type: "SYNC_STATUS" });
    const pct = status.bytes
      ? Math.round((status.bytes / status.quota) * 100)
      : 0;
    showModal(
      `<h2>Settings</h2>
       <div class="toggle-row">
         <div class="toggle-text">
           <div><strong>Sync across devices</strong></div>
           <div class="toggle-sub">
             Uses the Chrome profile you are already signed into, so there is no separate
             account. Chrome caps this at about 100KB, so thumbnails and media links are not
             synced and very large libraries sync only the most recent ads.
           </div>
         </div>
         <input type="checkbox" id="sync-toggle" ${status.enabled ? "checked" : ""} />
       </div>
       ${
         status.enabled
           ? `<p class="note">Using ${fmtNum(status.bytes || 0)} of ${fmtNum(status.quota)} bytes (${pct}%).${
               status.meta
                 ? ` ${fmtNum(status.meta.synced)} of ${fmtNum(status.meta.total)} ads synced.`
                 : ""
             }</p>
              <div class="modal-actions">
                <button class="btn btn-primary" id="sync-push" type="button">Push now</button>
                <button class="btn btn-ghost" id="sync-pull" type="button">Pull now</button>
              </div>`
           : ""
       }
       <div class="toggle-row">
         <div class="toggle-text">
           <div><strong>Display name</strong></div>
           <div class="toggle-sub">Shown against ads you save in a team space.</div>
         </div>
       </div>
       <div class="form-row">
         <input type="text" id="display-name" value="${escapeHtml(state.identity.displayName || "Me")}" />
       </div>
       <div class="modal-actions">
         <button class="btn btn-primary" id="name-save" type="button">Save name</button>
       </div>`,
      (root) => {
        root
          .querySelector("#sync-toggle")
          .addEventListener("change", async (e) => {
            const res = await send({
              type: "SYNC_SET",
              enabled: e.target.checked,
            });
            if (!res.ok)
              alert("Could not change sync: " + (res.error || "unknown error"));
            closeModal();
            refresh();
          });
        const push = root.querySelector("#sync-push");
        if (push)
          push.addEventListener("click", async () => {
            const res = await send({ type: "SYNC_PUSH" });
            alert(
              res.ok
                ? `Synced ${res.synced} of ${res.total} ads.${res.truncated ? " The library exceeds Chrome's sync quota, so the oldest saves were left out." : ""}`
                : "Push failed: " + (res.error || "unknown"),
            );
          });
        const pull = root.querySelector("#sync-pull");
        if (pull)
          pull.addEventListener("click", async () => {
            const res = await send({ type: "SYNC_PULL" });
            alert(res.ok ? `Pulled ${res.pulled} new ads.` : "Pull failed");
            refresh();
          });
        root.querySelector("#name-save").addEventListener("click", async () => {
          const name = root.querySelector("#display-name").value.trim();
          if (!name) return;
          const { identity = {} } = await chrome.storage.local.get("identity");
          identity.displayName = name;
          await chrome.storage.local.set({ identity });
          closeModal();
          refresh();
        });
      },
    );
  };

  // -------------------------------------------------------------------
  // Bulk actions
  // -------------------------------------------------------------------

  const renderBulkbar = () => {
    $("#bulkbar").classList.toggle("hidden", state.selected.size === 0);
    $("#bulk-count").textContent = `${state.selected.size} selected`;
    const target = $("#bulk-list-target");
    target.innerHTML = spaceLists()
      .map(
        (l) =>
          `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`,
      )
      .join("");
    target.disabled = target.options.length === 0;
    $("#bulk-remove").textContent =
      state.activeList === "__all__" ? "Delete" : "Remove from list";
  };

  const bulkAdd = async () => {
    const listId = $("#bulk-list-target").value;
    if (!listId) return;
    await send({
      type: "LIST_OP",
      op: "add_ads",
      listId,
      adIds: [...state.selected],
    });
    state.selected.clear();
    refresh();
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
      if (!confirm(`Delete ${ids.length} ad(s) from every list in this space?`))
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
    refresh();
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

  const exportJson = () =>
    downloadBlob(
      JSON.stringify(visibleAds(), null, 2),
      `meta-ads-${Date.now()}.json`,
      "application/json",
    );

  const exportCsv = () => {
    const ads = visibleAds();
    const cols = [
      "id",
      "pageName",
      "isActive",
      "startDate",
      "endDate",
      "daysRunning",
      "platforms",
      "format",
      "lists",
      "savedBy",
      "savedAt",
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
            if (c === "lists")
              return cell(
                listsForAd(ad.id)
                  .map((l) => l.name)
                  .join("|"),
              );
            if (c === "savedAt")
              return cell(ad[c] ? new Date(ad[c]).toISOString() : "");
            if (c === "startDate" || c === "endDate")
              return cell(
                ad[c] ? new Date(ad[c]).toISOString().slice(0, 10) : "",
              );
            return cell(ad[c]);
          })
          .join(","),
      );
    }
    downloadBlob(lines.join("\n"), `meta-ads-${Date.now()}.csv`, "text/csv");
  };

  // -------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------

  $("#search").addEventListener("input", (e) => {
    state.search = e.target.value.trim();
    render();
  });
  for (const [sel, key] of [
    ["#filter-format", "format"],
    ["#filter-status", "status"],
    ["#sort", "sort"],
  ]) {
    $(sel).addEventListener("change", (e) => {
      state[key] = e.target.value;
      render();
    });
  }

  $("#space-select").addEventListener("change", async (e) => {
    await send({ type: "SPACE_OP", op: "activate", spaceId: e.target.value });
    state.activeList = "__all__";
    state.selected.clear();
    refresh();
  });

  $("#btn-new-space").addEventListener("click", async () => {
    const name = prompt("Name the new space:");
    if (!name) return;
    await send({ type: "SPACE_OP", op: "create", kind: "personal", name });
    state.activeList = "__all__";
    refresh();
  });

  $("#btn-team").addEventListener("click", openTeamModal);
  $("#btn-settings").addEventListener("click", openSettingsModal);

  $("#import-file").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const res = await send({ type: "IMPORT_SPACE", payload });
      if (!res.ok) {
        alert("That file is not a valid space export.");
        return;
      }
      closeModal();
      state.activeList = "__all__";
      await refresh();
      alert(
        `Merged ${res.addedAds} new ads and ${res.addedLists} lists from ${res.from} into "${res.spaceName}".`,
      );
    } catch (err) {
      alert("Could not read that file.");
    }
  });

  document
    .querySelector('.nav-item[data-list="__all__"]')
    .addEventListener("click", () => {
      state.activeList = "__all__";
      state.selected.clear();
      render();
    });

  $("#btn-new-list").addEventListener("click", async () => {
    const name = prompt("List name:");
    if (!name) return;
    const res = await send({ type: "LIST_OP", op: "create", name });
    if (res.ok) state.activeList = res.list.id;
    refresh();
  });

  $("#btn-export-json").addEventListener("click", exportJson);
  $("#btn-export-csv").addEventListener("click", exportCsv);
  $("#bulk-add").addEventListener("click", bulkAdd);
  $("#bulk-download").addEventListener("click", bulkDownload);
  $("#bulk-remove").addEventListener("click", bulkRemove);
  $("#bulk-clear").addEventListener("click", () => {
    state.selected.clear();
    render();
  });

  const metricsToggle = $("#metrics-toggle");
  const applyMetricsCollapsed = (collapsed) => {
    $("#metrics").classList.toggle("collapsed", collapsed);
    metricsToggle.textContent = collapsed ? "Show" : "Hide";
  };
  metricsToggle.addEventListener("click", () => {
    const collapsed = !$("#metrics").classList.contains("collapsed");
    applyMetricsCollapsed(collapsed);
    try {
      localStorage.setItem("mal.metricsCollapsed", collapsed ? "1" : "0");
    } catch (err) {
      /* storage blocked; the toggle still works for this session */
    }
  });
  try {
    applyMetricsCollapsed(localStorage.getItem("mal.metricsCollapsed") === "1");
  } catch (err) {
    applyMetricsCollapsed(false);
  }

  $("#modal .modal-backdrop").addEventListener("click", closeModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.ads || changes.lists || changes.spaces))
      refresh();
  });

  refresh();
})();
