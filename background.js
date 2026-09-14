/**
 * Service worker: owns all persisted state, media downloads, and sync.
 *
 * Storage schema (chrome.storage.local):
 *   spaces:   { [spaceId]: { id, name, code, kind, createdAt } }
 *             kind is 'personal' or 'team'; team spaces carry a join code.
 *   lists:    { [listId]: { id, spaceId, name, color, adIds[], createdAt } }
 *   ads:      { [adId]: normalizedAd & { savedAt, savedBy, thumbDataUrl? } }
 *   settings: { activeSpaceId, syncEnabled }
 *   identity: { userId, displayName }
 *   frames_<adId>: { v, adId, source, duration, frames[{t, dataUrl}], error? }
 *   frameQueue: [{ adId, url, source }] - pending video frame extractions
 *   scores:   { [adId]: { adId, rubricVersion, model, axes, overall, ... } }
 *   canvases: { [canvasId]: { id, spaceId, name, nodes[], edges[], ... } }
 *   canvasRuns: { [runId]: { id, canvasId, status, inputDigest, shotList[], script } }
 *
 * frames_* keys are deliberately top-level rather than fields on the ad record:
 * getStore() deserialises every ad on every state read, and a few hundred KB of
 * JPEG per ad would make that unusable.
 *
 * Ads are stored once and referenced by lists, so the same ad saved into two
 * lists is one record. A space's ads are the union of its lists' adIds.
 */

const THUMB_MAX_BYTES = 160 * 1024;

// Validated light-mode categorical hues, used as list label colors.
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

// Unambiguous alphabet for join codes: no O/0, I/1, S/5.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRTUVWXYZ2346789";

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

const getStore = async () => {
  const {
    spaces = {},
    lists = {},
    ads = {},
    settings = {},
    identity = {},
  } = await chrome.storage.local.get([
    "spaces",
    "lists",
    "ads",
    "settings",
    "identity",
  ]);
  return { spaces, lists, ads, settings, identity };
};

const uid = (prefix) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const teamCode = () => {
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
};

const sanitize = (name) =>
  String(name || "unknown")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "unknown";

const extFromUrl = (url, fallback) => {
  try {
    const p = new URL(url).pathname;
    const m = p.match(/\.([a-z0-9]{2,5})$/i);
    if (m) return m[1].toLowerCase();
  } catch (err) {
    /* not a parseable URL; fall through */
  }
  return fallback;
};

/**
 * First run (and any run where state was cleared) needs a personal space with
 * one list, plus a stable local identity used to attribute saves in a team.
 */
const ensureBootstrapped = async () => {
  const store = await getStore();
  const patch = {};

  if (!store.identity.userId) {
    store.identity = {
      userId: uid("user"),
      displayName: "Me",
      ...store.identity,
    };
    patch.identity = store.identity;
  }

  if (Object.keys(store.spaces).length === 0) {
    const space = {
      id: uid("space"),
      name: "My Library",
      code: null,
      kind: "personal",
      createdAt: Date.now(),
    };
    store.spaces[space.id] = space;
    const list = {
      id: uid("list"),
      spaceId: space.id,
      name: "Saved",
      color: LIST_COLORS[0],
      adIds: [],
      createdAt: Date.now(),
    };
    store.lists[list.id] = list;
    store.settings = { ...store.settings, activeSpaceId: space.id };
    patch.spaces = store.spaces;
    patch.lists = store.lists;
    patch.settings = store.settings;
  }

  if (
    !store.settings.activeSpaceId ||
    !store.spaces[store.settings.activeSpaceId]
  ) {
    store.settings = {
      ...store.settings,
      activeSpaceId: Object.keys(store.spaces)[0],
    };
    patch.settings = store.settings;
  }

  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  return store;
};

chrome.runtime.onInstalled.addListener(() => {
  ensureBootstrapped();
});

// A worker death mid-batch leaves jobs in the queue; any later wake resumes it.
chrome.runtime.onStartup.addListener(() => {
  pumpFrames();
});

// ---------------------------------------------------------------------------
// Thumbnails: CDN URLs are signed and expire, so keep a small local preview.
// ---------------------------------------------------------------------------

const fetchThumbDataUrl = async (url) => {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size === 0 || blob.size > THUMB_MAX_BYTES * 6) return null;
    const buf = await blob.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    const dataUrl = `data:${blob.type || "image/jpeg"};base64,${btoa(binary)}`;
    return dataUrl.length > THUMB_MAX_BYTES * 8 ? null : dataUrl;
  } catch (err) {
    return null;
  }
};

const pickThumbSource = (ad) => {
  for (const m of ad.media || []) {
    if (m.previewUrl) return m.previewUrl;
    if (m.type === "image" && m.url) return m.url;
  }
  return null;
};

// ---------------------------------------------------------------------------
// Video frames
//
// Scoring an ad needs to see it, and a 160KB thumbnail is not seeing it. Frames
// are captured at save time, not at score time, because fbcdn links are signed
// and dead within hours - by the time someone clicks Score, the only ad worth
// scoring (the one that has been running for months) is the one whose URL has
// certainly expired.
//
// The decode happens in offscreen/frames.js because the worker has no DOM. This
// half owns the queue, the single offscreen document, and cleanup; it never
// holds a frame in memory.
// ---------------------------------------------------------------------------

const FRAMES_IDLE_CLOSE_MS = 15000;
const OFFSCREEN_PATH = "offscreen/frames.html";

let offscreenReady = null;
let offscreenCloseTimer = null;
let framesPumping = false;

/** The best video URL on an ad, and how good it is, so a low-res capture can be
 *  redone when the HD record arrives later. */
const pickVideoSource = (ad) => {
  for (const m of ad.media || []) {
    if (m.type !== "video") continue;
    if (m.hdUrl && /^https?:/.test(m.hdUrl)) return { url: m.hdUrl, source: "hd" };
    if (m.sdUrl && /^https?:/.test(m.sdUrl)) return { url: m.sdUrl, source: "sd" };
    if (m.url && /^https?:/.test(m.url)) return { url: m.url, source: "sd" };
  }
  return null;
};

/**
 * One offscreen document per profile, so creation has to be serialised: a
 * second createDocument() while the first is in flight throws.
 */
const ensureOffscreen = async () => {
  if (offscreenCloseTimer) {
    clearTimeout(offscreenCloseTimer);
    offscreenCloseTimer = null;
  }
  if (!offscreenReady) {
    offscreenReady = (async () => {
      const existing = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
      });
      if (existing.length) return;
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ["BLOBS"],
        justification:
          "Decode a saved ad video into still frames. The video is fetched first and read from a blob URL.",
      });
    })().catch((err) => {
      offscreenReady = null;
      throw err;
    });
  }
  return offscreenReady;
};

const closeOffscreenLater = () => {
  if (offscreenCloseTimer) clearTimeout(offscreenCloseTimer);
  offscreenCloseTimer = setTimeout(async () => {
    offscreenCloseTimer = null;
    offscreenReady = null;
    try {
      await chrome.offscreen.closeDocument();
    } catch (err) {
      /* already closed, or never opened */
    }
  }, FRAMES_IDLE_CLOSE_MS);
};

/** The queue is persisted so a worker death mid-batch resumes rather than
 *  silently dropping the rest. */
const enqueueFrames = async (jobs) => {
  if (!jobs.length) return;
  const { frameQueue = [] } = await chrome.storage.local.get("frameQueue");
  const known = new Set(frameQueue.map((j) => j.adId));
  const next = [...frameQueue];
  for (const job of jobs) {
    if (known.has(job.adId)) continue;
    known.add(job.adId);
    next.push(job);
  }
  await chrome.storage.local.set({ frameQueue: next });
  pumpFrames();
};

const pumpFrames = async () => {
  if (framesPumping) return;
  framesPumping = true;
  try {
    for (;;) {
      const { frameQueue = [] } = await chrome.storage.local.get("frameQueue");
      const job = frameQueue[0];
      if (!job) break;

      let result;
      try {
        await ensureOffscreen();
        result = await chrome.runtime.sendMessage({
          target: "frames-offscreen",
          type: "EXTRACT_FRAMES",
          adId: job.adId,
          url: job.url,
          source: job.source,
        });
      } catch (err) {
        result = { ok: false, error: String(err?.message || err) };
      }

      // A failure is recorded rather than retried forever: a signed URL that
      // has expired will never succeed, and an ad with no frames must read as
      // "could not capture", not as an ad that scored badly.
      if (!result || !result.ok) {
        await chrome.storage.local.set({
          [`frames_${job.adId}`]: {
            v: 1,
            adId: job.adId,
            source: job.source,
            error: (result && result.error) || "extraction failed",
            capturedAt: Date.now(),
            frames: [],
          },
        });
      }

      const { frameQueue: current = [] } =
        await chrome.storage.local.get("frameQueue");
      await chrome.storage.local.set({
        frameQueue: current.filter((j) => j.adId !== job.adId),
      });
    }
  } finally {
    framesPumping = false;
    closeOffscreenLater();
  }
};

/** Frames are large and are stored under their own keys, never on the ad
 *  record, because getStore() deserialises every ad on every state read. */
const dropFrames = async (adIds) => {
  const keys = adIds.map((id) => `frames_${id}`);
  if (keys.length) await chrome.storage.local.remove(keys);
};

const getFrames = async (adId) => {
  const key = `frames_${adId}`;
  const stored = await chrome.storage.local.get(key);
  return stored[key] || null;
};

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

/**
 * Resolve the list a save lands in: an explicit choice wins, then the list the
 * user pinned as their default in the panel, then the space's first list.
 */
const resolveTargetList = (store, listId) => {
  if (listId && store.lists[listId]) return store.lists[listId];
  const spaceId = store.settings.activeSpaceId;
  const pinned = store.lists[store.settings.defaultListId];
  if (pinned && pinned.spaceId === spaceId) return pinned;
  const inSpace = Object.values(store.lists)
    .filter((l) => l.spaceId === spaceId)
    .sort((a, b) => a.createdAt - b.createdAt);
  return inSpace[0] || null;
};

/** Pin the list new saves default to, for the current space. */
/** Theme preference: "system" follows the OS, otherwise an explicit choice. */
const handleSetTheme = async (theme) => {
  const { settings } = await getStore();
  settings.theme = ["system", "light", "dark"].includes(theme)
    ? theme
    : "system";
  await chrome.storage.local.set({ settings });
  return { ok: true, theme: settings.theme };
};

const handleSetDownloadFolder = async (mode) => {
  const { settings } = await getStore();
  settings.downloadFolder = ["list", "advertiser", "flat"].includes(mode)
    ? mode
    : "list";
  await chrome.storage.local.set({ settings });
  return { ok: true, mode: settings.downloadFolder };
};

const handleSetDefaultList = async (listId) => {
  const { settings, lists } = await getStore();
  if (listId && !lists[listId]) return { ok: false, error: "not_found" };
  settings.defaultListId = listId || null;
  await chrome.storage.local.set({ settings });
  return { ok: true };
};

const handleSaveAds = async (incoming, listId) => {
  const store = await ensureBootstrapped();
  const { ads, lists, identity } = store;
  const target = resolveTargetList(store, listId);
  if (!target) return { ok: false, error: "no_list" };

  let added = 0;
  const toThumb = [];
  const toFrames = [];
  const memberIds = new Set(target.adIds);

  for (const ad of incoming) {
    if (!ad || !ad.id) continue;
    if (!ads[ad.id]) {
      ads[ad.id] = {
        ...ad,
        savedAt: Date.now(),
        savedBy: identity.displayName || "Me",
        savedByog: identity.userId,
      };
      toThumb.push(ad.id);
      const video = pickVideoSource(ad);
      if (video) toFrames.push({ adId: ad.id, ...video });
    } else {
      // A card first saved from the DOM carries a low-res video; the GraphQL
      // record arriving later upgrades it, and frames taken from the low-res
      // copy would otherwise stay permanent.
      const before = pickVideoSource(ads[ad.id]);
      const after = pickVideoSource(ad);
      if (after && after.source === "hd" && (!before || before.source !== "hd"))
        toFrames.push({ adId: ad.id, ...after });
      // Refresh volatile fields (media URLs, active state), keep provenance.
      ads[ad.id] = {
        ...ads[ad.id],
        ...ad,
        savedAt: ads[ad.id].savedAt,
        savedBy: ads[ad.id].savedBy,
      };
    }
    if (!memberIds.has(ad.id)) {
      memberIds.add(ad.id);
      added += 1;
    }
  }

  target.adIds = [...memberIds];
  lists[target.id] = target;
  await chrome.storage.local.set({ ads, lists });

  // Thumbnails are best-effort and must never delay the save response.
  (async () => {
    let dirty = false;
    for (const id of toThumb) {
      const src = pickThumbSource(ads[id]);
      if (!src) continue;
      const thumb = await fetchThumbDataUrl(src);
      if (thumb) {
        ads[id].thumbDataUrl = thumb;
        dirty = true;
      }
    }
    if (dirty) await chrome.storage.local.set({ ads });
  })();

  // Frames are the same class of work as thumbnails - best effort, after the
  // response, and only for video ads.
  if (toFrames.length) enqueueFrames(toFrames);

  return { ok: true, added, listId: target.id, listName: target.name };
};

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

/**
 * Where a download lands. Defaults to a folder per list, which is what makes
 * a swipe file usable on disk; "advertiser" and "flat" are the alternatives.
 */
const downloadFolder = (ad, store, listId) => {
  const mode = store.settings.downloadFolder || "list";
  if (mode === "flat") return "MetaAdsLibrary";
  if (mode === "advertiser") return `MetaAdsLibrary/${sanitize(ad.pageName)}`;
  const explicit = listId && store.lists[listId];
  const owning =
    explicit ||
    Object.values(store.lists)
      .filter(
        (l) =>
          l.spaceId === store.settings.activeSpaceId &&
          (l.adIds || []).includes(ad.id),
      )
      .sort((x, y) => x.createdAt - y.createdAt)[0];
  return `MetaAdsLibrary/${sanitize(owning ? owning.name : "Unsorted")}`;
};

/** Best available URL for one media item, and how good it is. */
const pickMediaUrl = (m) => {
  if (m.type === "video") {
    if (m.hdUrl) return { url: m.hdUrl, quality: "hd" };
    const url = m.sdUrl || m.url;
    return url ? { url, quality: m.lowRes ? "low" : "sd" } : null;
  }
  return m.url ? { url: m.url, quality: "sd" } : null;
};

const handleDownloadAd = async (ad, listId) => {
  const store = await ensureBootstrapped();
  const folder = downloadFolder(ad, store, listId);
  const media = ad.media || [];
  let count = 0;
  let best = null;

  for (let i = 0; i < media.length; i++) {
    const pick = pickMediaUrl(media[i]);
    // blob: URLs are in-page MSE streams and cannot be fetched.
    if (!pick || !/^https?:/i.test(pick.url)) continue;
    const ext = extFromUrl(pick.url, media[i].type === "video" ? "mp4" : "jpg");
    const suffix = media.length > 1 ? `_${i + 1}` : "";
    const base = `${sanitize(ad.pageName)}-${ad.id}${suffix}`;
    try {
      await chrome.downloads.download({
        url: pick.url,
        filename: `${folder}/${base}.${ext}`,
        conflictAction: "uniquify",
        saveAs: false,
      });
      count += 1;
      if (pick.quality === "hd" || !best) best = pick.quality;
    } catch (err) {
      // One expired URL should not abort the rest of the batch.
    }
  }

  if (count === 0)
    return {
      ok: false,
      count: 0,
      reason: media.length ? "unusable" : "no_media",
    };
  return { ok: true, count, quality: best, folder };
};

// ---------------------------------------------------------------------------
// Spaces
// ---------------------------------------------------------------------------

const handleSpaceOp = async (msg) => {
  const store = await ensureBootstrapped();
  const { spaces, lists, ads, settings } = store;

  switch (msg.op) {
    /**
     * Bind a local space to a remote team. The space keeps its local id, so
     * nothing already saved has to move; it just gains the team it belongs to
     * and the code teammates use to find it.
     */
    case "link": {
      const space = spaces[msg.spaceId];
      if (!space) return { ok: false, error: "no such space" };
      space.teamId = msg.teamId;
      space.code = msg.code || space.code;
      space.kind = "team";
      await chrome.storage.local.set({ spaces });
      return { ok: true, space };
    }

    /** Record the remote ids a push handed back, so the next one updates. */
    case "link_lists": {
      for (const { localId, remoteId } of msg.links || []) {
        if (lists[localId]) lists[localId].remoteId = remoteId;
      }
      await chrome.storage.local.set({ lists });
      return { ok: true, linked: (msg.links || []).length };
    }

    case "create": {
      const kind = msg.kind === "team" ? "team" : "personal";
      const space = {
        id: uid("space"),
        name: msg.name || (kind === "team" ? "Team space" : "New space"),
        code: kind === "team" ? teamCode() : null,
        kind,
        createdAt: Date.now(),
      };
      spaces[space.id] = space;
      const list = {
        id: uid("list"),
        spaceId: space.id,
        name: "Saved",
        color: LIST_COLORS[0],
        adIds: [],
        createdAt: Date.now(),
      };
      lists[list.id] = list;
      settings.activeSpaceId = space.id;
      await chrome.storage.local.set({ spaces, lists, settings });
      return { ok: true, space };
    }
    case "rename": {
      if (!spaces[msg.spaceId]) return { ok: false, error: "not_found" };
      spaces[msg.spaceId].name = msg.name || spaces[msg.spaceId].name;
      await chrome.storage.local.set({ spaces });
      return { ok: true };
    }
    case "activate": {
      if (!spaces[msg.spaceId]) return { ok: false, error: "not_found" };
      settings.activeSpaceId = msg.spaceId;
      await chrome.storage.local.set({ settings });
      return { ok: true };
    }
    case "delete": {
      if (Object.keys(spaces).length <= 1)
        return { ok: false, error: "last_space" };
      // Drop the space, its lists, and any ad left in no list at all.
      delete spaces[msg.spaceId];
      for (const list of Object.values(lists)) {
        if (list.spaceId === msg.spaceId) delete lists[list.id];
      }
      const { canvases, canvasRuns } = await canvasStore();
      for (const canvas of Object.values(canvases))
        if (canvas.spaceId === msg.spaceId) {
          delete canvases[canvas.id];
          for (const run of Object.values(canvasRuns))
            if (run.canvasId === canvas.id) delete canvasRuns[run.id];
        }
      await chrome.storage.local.set({ canvases, canvasRuns });

      const referenced = new Set();
      for (const list of Object.values(lists))
        for (const id of list.adIds) referenced.add(id);
      // An ad in no list but on a surviving canvas is still in use. Without
      // this, deleting one space silently strips live data out from under a
      // canvas in another one.
      for (const id of canvasReferencedAds(canvases)) referenced.add(id);
      const reaped = [];
      for (const id of Object.keys(ads))
        if (!referenced.has(id)) {
          reaped.push(id);
          delete ads[id];
        }
      await dropFrames(reaped);
      await dropScores(reaped);
      if (settings.activeSpaceId === msg.spaceId)
        settings.activeSpaceId = Object.keys(spaces)[0];
      await chrome.storage.local.set({ spaces, lists, ads, settings });
      return { ok: true };
    }
    default:
      return { ok: false, error: "unknown_op" };
  }
};

/**
 * Export a space as a shareable bundle. Team members merge these into the same
 * space because the bundle carries the space's join code as its identity.
 * Thumbnails are stripped so the file stays small enough to share.
 */
const handleExportSpace = async (spaceId) => {
  const { spaces, lists, ads, identity } = await getStore();
  const space = spaces[spaceId];
  if (!space) return { ok: false, error: "not_found" };
  const spaceLists = Object.values(lists).filter((l) => l.spaceId === spaceId);
  const ids = new Set();
  for (const l of spaceLists) for (const id of l.adIds) ids.add(id);
  const payload = {
    v: 1,
    space: { name: space.name, code: space.code, kind: space.kind },
    lists: spaceLists.map((l) => ({
      name: l.name,
      color: l.color,
      adIds: l.adIds,
    })),
    ads: [...ids].map((id) => {
      const { thumbDataUrl, ...rest } = ads[id] || {};
      return rest;
    }),
    exportedBy: identity.displayName || "Someone",
    exportedAt: Date.now(),
  };
  return { ok: true, payload };
};

/**
 * Merge a bundle. Matching on the join code means repeated imports from
 * several teammates accumulate into one space rather than making duplicates.
 */
const handleImportSpace = async (payload) => {
  if (!payload || payload.v !== 1 || !payload.space)
    return { ok: false, error: "bad_bundle" };
  const store = await ensureBootstrapped();
  const { spaces, lists, ads, settings } = store;

  let space = Object.values(spaces).find(
    (s) => s.code && payload.space.code && s.code === payload.space.code,
  );
  if (!space) {
    space = {
      id: uid("space"),
      name: payload.space.name || "Team space",
      code: payload.space.code || teamCode(),
      kind: "team",
      createdAt: Date.now(),
    };
    spaces[space.id] = space;
  }

  let addedAds = 0;
  for (const ad of payload.ads || []) {
    if (!ad || !ad.id) continue;
    if (!ads[ad.id]) {
      ads[ad.id] = ad;
      addedAds += 1;
    }
  }

  let addedLists = 0;
  for (const incoming of payload.lists || []) {
    let list = Object.values(lists).find(
      (l) => l.spaceId === space.id && l.name === incoming.name,
    );
    if (!list) {
      list = {
        id: uid("list"),
        spaceId: space.id,
        name: incoming.name || "Shared",
        color: incoming.color || LIST_COLORS[0],
        adIds: [],
        createdAt: Date.now(),
      };
      lists[list.id] = list;
      addedLists += 1;
    }
    const merged = new Set(list.adIds);
    for (const id of incoming.adIds || []) if (ads[id]) merged.add(id);
    list.adIds = [...merged];
  }

  settings.activeSpaceId = space.id;
  await chrome.storage.local.set({ spaces, lists, ads, settings });
  return {
    ok: true,
    spaceId: space.id,
    spaceName: space.name,
    addedAds,
    addedLists,
    from: payload.exportedBy || "a teammate",
  };
};

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

const handleListOp = async (msg) => {
  const store = await ensureBootstrapped();
  const { lists, settings } = store;

  switch (msg.op) {
    case "create": {
      const spaceId = msg.spaceId || settings.activeSpaceId;
      const used = Object.values(lists).filter(
        (l) => l.spaceId === spaceId,
      ).length;
      const list = {
        id: uid("list"),
        spaceId,
        name: msg.name || "Untitled list",
        color: msg.color || LIST_COLORS[used % LIST_COLORS.length],
        adIds: [],
        createdAt: Date.now(),
      };
      lists[list.id] = list;
      await chrome.storage.local.set({ lists });
      return { ok: true, list };
    }
    case "rename": {
      if (!lists[msg.listId]) return { ok: false, error: "not_found" };
      lists[msg.listId].name = msg.name || lists[msg.listId].name;
      await chrome.storage.local.set({ lists });
      return { ok: true };
    }
    case "recolor": {
      if (!lists[msg.listId]) return { ok: false, error: "not_found" };
      lists[msg.listId].color = msg.color || lists[msg.listId].color;
      await chrome.storage.local.set({ lists });
      return { ok: true };
    }
    case "delete": {
      delete lists[msg.listId];
      await chrome.storage.local.set({ lists });
      return { ok: true };
    }
    case "add_ads": {
      const list = lists[msg.listId];
      if (!list) return { ok: false, error: "not_found" };
      const set = new Set(list.adIds);
      for (const id of msg.adIds || []) set.add(id);
      list.adIds = [...set];
      await chrome.storage.local.set({ lists });
      return { ok: true, size: list.adIds.length };
    }
    case "remove_ads": {
      const list = lists[msg.listId];
      if (!list) return { ok: false, error: "not_found" };
      const remove = new Set(msg.adIds || []);
      list.adIds = list.adIds.filter((id) => !remove.has(id));
      await chrome.storage.local.set({ lists });
      return { ok: true, size: list.adIds.length };
    }
    default:
      return { ok: false, error: "unknown_op" };
  }
};

/**
 * Remove ads outright: drop them from every list and from the ad store.
 *
 * Canvases are deliberately not touched. The user deleted an ad from their
 * library, not the brief they wrote about it; the node keeps its note and its
 * snapshot and renders as a reference that is no longer in the library.
 */
const handleDeleteAds = async (adIds) => {
  const { ads, lists } = await getStore();
  const remove = new Set(adIds);
  for (const id of remove) delete ads[id];
  for (const list of Object.values(lists)) {
    list.adIds = list.adIds.filter((id) => !remove.has(id));
  }
  await chrome.storage.local.set({ ads, lists });
  await dropFrames([...remove]);
  await dropScores([...remove]);
  return { ok: true };
};

// ---------------------------------------------------------------------------
// Cross-device sync via chrome.storage.sync
//
// This rides the Chrome profile the user is already signed into, so there is
// no separate account to create. The trade-off is a hard quota (~100KB), so
// records are stripped to the fields that stay useful on another device -
// signed CDN media URLs expire anyway and are dropped - then packed into
// chunks under the 8KB per-item limit. Capacity is reported back to the UI
// rather than silently truncating.
// ---------------------------------------------------------------------------

const SYNC_CHUNK_BYTES = 7000;
const SYNC_MAX_CHUNKS = 11;

const slimAdForSync = (ad) => ({
  id: ad.id,
  pageName: ad.pageName,
  pageId: ad.pageId,
  isActive: ad.isActive,
  startDate: ad.startDate,
  endDate: ad.endDate,
  platforms: ad.platforms,
  displayFormat: ad.displayFormat,
  title: ad.title,
  body: ad.body ? String(ad.body).slice(0, 240) : null,
  ctaText: ad.ctaText,
  linkUrl: ad.linkUrl,
  libraryUrl: ad.libraryUrl,
  collationCount: ad.collationCount,
  mediaKinds: (ad.media || []).map((m) => m.type),
  savedAt: ad.savedAt,
  savedBy: ad.savedBy,
});

const chunkRecords = (records) => {
  const chunks = [];
  let current = [];
  let size = 2;
  for (const rec of records) {
    const json = JSON.stringify(rec);
    if (size + json.length + 1 > SYNC_CHUNK_BYTES && current.length) {
      chunks.push(current);
      current = [];
      size = 2;
    }
    current.push(rec);
    size += json.length + 1;
  }
  if (current.length) chunks.push(current);
  return chunks;
};

const handleSyncPush = async () => {
  const { spaces, lists, ads, settings } = await getStore();
  if (!settings.syncEnabled) return { ok: false, error: "sync_disabled" };

  const referenced = new Set();
  for (const list of Object.values(lists))
    for (const id of list.adIds) referenced.add(id);

  const slim = [...referenced]
    .map((id) => ads[id])
    .filter(Boolean)
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
    .map(slimAdForSync);

  const chunks = chunkRecords(slim);
  const kept = chunks.slice(0, SYNC_MAX_CHUNKS);
  const droppedChunks = chunks.length - kept.length;
  const syncedCount = kept.reduce((n, c) => n + c.length, 0);

  const payload = {
    sync_meta: {
      v: 1,
      chunks: kept.length,
      updatedAt: Date.now(),
      total: slim.length,
      synced: syncedCount,
    },
    sync_spaces: Object.values(spaces),
    sync_lists: Object.values(lists).map((l) => ({
      id: l.id,
      spaceId: l.spaceId,
      name: l.name,
      color: l.color,
      adIds: l.adIds,
      createdAt: l.createdAt,
    })),
  };
  kept.forEach((chunk, i) => {
    payload[`sync_ads_${i}`] = chunk;
  });

  try {
    // Clear stale chunks from a previous, larger push before writing.
    const existing = await chrome.storage.sync.get(null);
    const stale = Object.keys(existing).filter(
      (k) =>
        k.startsWith("sync_ads_") &&
        Number(k.slice("sync_ads_".length)) >= kept.length,
    );
    if (stale.length) await chrome.storage.sync.remove(stale);
    await chrome.storage.sync.set(payload);
  } catch (err) {
    return { ok: false, error: String(err && err.message) };
  }

  return {
    ok: true,
    synced: syncedCount,
    total: slim.length,
    truncated: droppedChunks > 0,
  };
};

const handleSyncPull = async () => {
  const store = await ensureBootstrapped();
  const { spaces, lists, ads, settings } = store;
  if (!settings.syncEnabled) return { ok: false, error: "sync_disabled" };

  let remote;
  try {
    remote = await chrome.storage.sync.get(null);
  } catch (err) {
    return { ok: false, error: String(err && err.message) };
  }
  if (!remote.sync_meta) return { ok: true, pulled: 0, empty: true };

  for (const space of remote.sync_spaces || []) {
    if (!spaces[space.id]) spaces[space.id] = space;
  }

  let pulled = 0;
  for (let i = 0; i < (remote.sync_meta.chunks || 0); i++) {
    for (const ad of remote[`sync_ads_${i}`] || []) {
      if (!ad || !ad.id) continue;
      if (!ads[ad.id]) {
        // A synced record has no media URLs; the library link still resolves.
        ads[ad.id] = { ...ad, media: [] };
        pulled += 1;
      }
    }
  }

  for (const rl of remote.sync_lists || []) {
    const local = lists[rl.id];
    if (!local) {
      lists[rl.id] = { ...rl, adIds: (rl.adIds || []).filter((id) => ads[id]) };
    } else {
      const merged = new Set(local.adIds);
      for (const id of rl.adIds || []) if (ads[id]) merged.add(id);
      local.adIds = [...merged];
    }
  }

  await chrome.storage.local.set({ spaces, lists, ads });
  return { ok: true, pulled };
};

const handleSyncSet = async (enabled) => {
  const { settings } = await getStore();
  settings.syncEnabled = !!enabled;
  await chrome.storage.local.set({ settings });
  if (enabled) {
    const pull = await handleSyncPull();
    const push = await handleSyncPush();
    return { ok: true, enabled: true, pull, push };
  }
  return { ok: true, enabled: false };
};

const handleSyncStatus = async () => {
  const { settings } = await getStore();
  if (!settings.syncEnabled) return { ok: true, enabled: false };
  let bytes = 0;
  let meta = null;
  try {
    bytes = await chrome.storage.sync.getBytesInUse(null);
    ({ sync_meta: meta } = await chrome.storage.sync.get("sync_meta"));
  } catch (err) {
    /* quota probe is advisory only */
  }
  return {
    ok: true,
    enabled: true,
    bytes,
    quota: chrome.storage.sync.QUOTA_BYTES || 102400,
    meta: meta || null,
  };
};

/**
 * Capture frames on demand for ads that have none. Used by the score button so
 * an ad saved before this feature existed can still be scored - it will only
 * work while its CDN URL is still signed, which is why capture at save time is
 * the real path and this is the fallback.
 */
const handleFramesRequest = async (adIds) => {
  const { ads } = await getStore();
  const jobs = [];
  const already = [];
  for (const id of adIds) {
    const ad = ads[id];
    if (!ad) continue;
    const existing = await getFrames(id);
    if (existing && existing.frames && existing.frames.length) {
      already.push(id);
      continue;
    }
    const video = pickVideoSource(ad);
    if (video) jobs.push({ adId: id, ...video });
  }
  await enqueueFrames(jobs);
  return { ok: true, queued: jobs.length, already: already.length };
};

// ---------------------------------------------------------------------------
// Canvases
//
// A canvas is a brief: reference ads as nodes, each with a free-text note
// saying what to take from it, wired into an output node that generates a shot
// list and a script.
//
// Two decisions in here are load-bearing.
//
// A node references an ad by archive id and also carries a text snapshot of it.
// The snapshot is what makes a deleted ad a degraded node rather than a blank
// one: the note somebody wrote about an ad is canvas-owned work, and library
// housekeeping must never destroy it. The snapshot is text only - CDN links are
// signed and expire within hours, and the local thumbnail is a data URL that
// would make a twenty-node canvas multiple megabytes and dead within a day.
//
// The graph is the only mutable state. A generation is an append-only run with
// provenance, never an editable field on the canvas, because the output is not
// actually regenerable: the model is nondeterministic and two of its inputs
// decay. Re-running is a new draft, not a refresh, and it re-bills.
// ---------------------------------------------------------------------------

const canvasStore = async () => {
  const { canvases = {}, canvasRuns = {} } = await chrome.storage.local.get([
    "canvases",
    "canvasRuns",
  ]);
  return { canvases, canvasRuns };
};

/** Ids are uuids from birth so they never need remapping on a push. */
const canvasId = () => crypto.randomUUID();

const handleCanvasOp = async (msg) => {
  const { canvases, canvasRuns } = await canvasStore();
  const { settings } = await getStore();
  const spaceId = msg.spaceId || settings.activeSpaceId;

  switch (msg.op) {
    case "list": {
      const mine = Object.values(canvases)
        .filter((c) => c.spaceId === spaceId)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      return { ok: true, canvases: mine };
    }
    case "get": {
      const canvas = canvases[msg.canvasId];
      if (!canvas) return { ok: false, error: "not_found" };
      const runs = Object.values(canvasRuns)
        .filter((r) => r.canvasId === canvas.id)
        .sort((a, b) => b.createdAt - a.createdAt);
      return { ok: true, canvas, runs };
    }
    case "create": {
      const id = canvasId();
      const now = Date.now();
      canvases[id] = {
        id,
        spaceId,
        name: (msg.name || "Untitled canvas").slice(0, 80),
        // Every canvas is born with the output node, because a graph with
        // nothing to generate into is not a brief.
        nodes: [
          {
            id: canvasId(),
            kind: "output",
            note: "",
            x: 640,
            y: 220,
          },
        ],
        edges: [],
        createdAt: now,
        updatedAt: now,
      };
      await chrome.storage.local.set({ canvases });
      return { ok: true, canvas: canvases[id] };
    }
    case "rename": {
      const canvas = canvases[msg.canvasId];
      if (!canvas) return { ok: false, error: "not_found" };
      canvas.name = (msg.name || canvas.name).slice(0, 80);
      canvas.updatedAt = Date.now();
      await chrome.storage.local.set({ canvases });
      return { ok: true, canvas };
    }
    case "save": {
      const canvas = canvases[msg.canvasId];
      if (!canvas) return { ok: false, error: "not_found" };
      if (Array.isArray(msg.nodes)) canvas.nodes = msg.nodes;
      if (Array.isArray(msg.edges)) canvas.edges = msg.edges;
      canvas.updatedAt = Date.now();
      await chrome.storage.local.set({ canvases });
      return { ok: true, canvas };
    }
    case "delete": {
      if (!canvases[msg.canvasId]) return { ok: false, error: "not_found" };
      delete canvases[msg.canvasId];
      for (const run of Object.values(canvasRuns))
        if (run.canvasId === msg.canvasId) delete canvasRuns[run.id];
      await chrome.storage.local.set({ canvases, canvasRuns });
      return { ok: true };
    }
    case "save_run": {
      const run = msg.run;
      if (!run || !run.canvasId) return { ok: false, error: "no_run" };
      run.id = run.id || canvasId();
      run.createdAt = run.createdAt || Date.now();
      canvasRuns[run.id] = run;
      await chrome.storage.local.set({ canvasRuns });
      return { ok: true, run };
    }
    default:
      return { ok: false, error: "unknown_op" };
  }
};

/** Every ad a canvas points at, so library reaping cannot strip one bare. */
const canvasReferencedAds = (canvases) => {
  const out = new Set();
  for (const canvas of Object.values(canvases))
    for (const node of canvas.nodes || []) if (node.adId) out.add(node.adId);
  return out;
};

// ---------------------------------------------------------------------------
// Scores
//
// Small enough to keep in one object, and deliberately outside getStore() so a
// state read does not carry them. Keyed by ad, then by rubric version, so an
// edit to the rubric makes old scores visibly non-comparable rather than
// silently so.
// ---------------------------------------------------------------------------

const handleScoresGet = async (adIds) => {
  const { scores = {} } = await chrome.storage.local.get("scores");
  if (!adIds || !adIds.length) return { ok: true, scores };
  const out = {};
  for (const id of adIds) if (scores[id]) out[id] = scores[id];
  return { ok: true, scores: out };
};

const handleScoreSave = async (score) => {
  if (!score || !score.adId) return { ok: false, error: "no_ad" };
  const { scores = {} } = await chrome.storage.local.get("scores");
  scores[score.adId] = score;
  await chrome.storage.local.set({ scores });
  return { ok: true };
};

const dropScores = async (adIds) => {
  const { scores = {} } = await chrome.storage.local.get("scores");
  let dirty = false;
  for (const id of adIds)
    if (scores[id]) {
      delete scores[id];
      dirty = true;
    }
  if (dirty) await chrome.storage.local.set({ scores });
};

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const respond = (promise) => {
    promise
      .then(sendResponse)
      .catch((err) =>
        sendResponse({ ok: false, error: String(err && err.message) }),
      );
    return true; // keep the channel open for the async reply
  };

  switch (msg && msg.type) {
    case "SAVE_ADS":
      return respond(handleSaveAds(msg.ads || [], msg.listId));
    case "DOWNLOAD_AD":
      return respond(handleDownloadAd(msg.ad || {}, msg.listId));
    case "GET_STATE":
      return respond(
        ensureBootstrapped().then(
          ({ spaces, lists, ads, settings, identity }) => ({
            ok: true,
            spaces,
            lists,
            ads,
            settings,
            identity,
          }),
        ),
      );
    case "GET_SAVE_TARGETS":
      return respond(
        ensureBootstrapped().then(({ spaces, lists, ads, settings }) => ({
          ok: true,
          spaces: Object.values(spaces),
          lists: Object.values(lists),
          activeSpaceId: settings.activeSpaceId,
          defaultListId: settings.defaultListId || null,
          theme: settings.theme || "system",
          savedIds: Object.keys(ads),
        })),
      );
    case "SET_THEME":
      return respond(handleSetTheme(msg.theme));
    case "SET_DOWNLOAD_FOLDER":
      return respond(handleSetDownloadFolder(msg.mode));
    case "SET_DEFAULT_LIST":
      return respond(handleSetDefaultList(msg.listId));
    case "SPACE_OP":
      return respond(handleSpaceOp(msg));
    case "EXPORT_SPACE":
      return respond(handleExportSpace(msg.spaceId));
    case "IMPORT_SPACE":
      return respond(handleImportSpace(msg.payload));
    case "LIST_OP":
      return respond(handleListOp(msg));
    case "DELETE_ADS":
      return respond(handleDeleteAds(msg.adIds || []));
    case "FRAMES_GET":
      return respond(
        getFrames(msg.adId).then((frames) => ({ ok: true, frames })),
      );
    case "FRAMES_REQUEST":
      return respond(handleFramesRequest(msg.adIds || []));
    case "SCORES_GET":
      return respond(handleScoresGet(msg.adIds || []));
    case "SCORE_SAVE":
      return respond(handleScoreSave(msg.score));
    case "CANVAS_OP":
      return respond(handleCanvasOp(msg));
    case "SYNC_SET":
      return respond(handleSyncSet(msg.enabled));
    case "SYNC_PUSH":
      return respond(handleSyncPush());
    case "SYNC_PULL":
      return respond(handleSyncPull());
    case "SYNC_STATUS":
      return respond(handleSyncStatus());
    case "OPEN_DASHBOARD":
      return respond(
        chrome.tabs
          .create({ url: chrome.runtime.getURL("dashboard/dashboard.html") })
          .then(() => ({ ok: true })),
      );
    case "APPLY_SYNC":
      return respond(handleApplySync(msg));
    case "OPEN_LIBRARY":
      return respond(openAdLibrary());
    case "OPEN_PANEL":
      return respond(openPanelFor(sender));
    default:
      return false;
  }
});

/**
 * Toolbar button. On the Ad Library it toggles the in-page panel (there is no
 * popup, so this fires instead); anywhere else there is no content script to
 * talk to, so open the dashboard.
 */
const LIBRARY_URL = "https://www.facebook.com/ads/library/";

// Focus an existing Ad Library tab if there is one, otherwise open it.
const openAdLibrary = async () => {
  const tabs = await chrome.tabs.query({
    url: [
      "https://www.facebook.com/ads/library*",
      "https://web.facebook.com/ads/library*",
    ],
  });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: LIBRARY_URL });
  }
  return { ok: true };
};

/**
 * sidePanel.open is per-window and wants a user gesture in the extension's own
 * context. A click relayed from a content script does not always count as one,
 * and when it does not, Chrome rejects. Rather than leave the caller with a
 * button that does nothing, fall back to the dashboard, which shows the same
 * lists and always opens.
 */
const openPanelFor = async (sender) => {
  const windowId = sender && sender.tab ? sender.tab.windowId : undefined;
  try {
    await chrome.sidePanel.open({ windowId });
    return { ok: true, where: "panel" };
  } catch (err) {
    await chrome.tabs.create({
      url: chrome.runtime.getURL("dashboard/dashboard.html"),
    });
    return { ok: true, where: "dashboard" };
  }
};

/**
 * The toolbar button opens the browser's own side panel, so the workspace is
 * docked beside the page on every tab rather than injected into one of them.
 * Chrome handles the open itself, which also means it counts as the user
 * gesture the sidePanel API requires.
 */
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.warn("[pake-ads] side panel behaviour:", err));

/**
 * Write back a merged team space.
 *
 * The merge itself happens in the page, where supabase-js lives, but the write
 * lands here so every change to the store goes through one place. Only the
 * space being synced is touched: lists belonging to other spaces are carried
 * over untouched, or a sync of one space would wipe the rest.
 */
const handleApplySync = async ({ spaceId, ads, lists }) => {
  const store = await ensureBootstrapped();
  const kept = Object.fromEntries(
    Object.entries(store.lists).filter(([, l]) => l.spaceId !== spaceId),
  );
  const merged = { ...kept, ...lists };
  await chrome.storage.local.set({ ads, lists: merged });
  return { ok: true, ads: Object.keys(ads).length, lists: Object.keys(merged).length };
};

// Keep local state fresh when another device pushes an update.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes.sync_meta) return;
  getStore().then(({ settings }) => {
    if (settings.syncEnabled) handleSyncPull();
  });
});
