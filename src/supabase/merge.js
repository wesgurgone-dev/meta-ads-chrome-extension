/**
 * Merging a team space's remote rows into the local store.
 *
 * Pure on purpose: no chrome, no network, no supabase-js. Everything that
 * decides what the library ends up looking like lives here and is unit tested,
 * because a merge bug quietly loses somebody's saved work and a network bug
 * just fails loudly.
 *
 * Three rules do all the work:
 *
 *   Ads are keyed by their Ad Library archive id, which is also the remote
 *   unique key, so the same creative saved by two people is one record with no
 *   id mapping to maintain.
 *
 *   Lists need a map, because their ids are local. Each local list carries the
 *   remote uuid it corresponds to once it has been pushed.
 *
 *   A tombstone wins over local presence. The row is gone for everyone, and a
 *   device that still holds it must drop it rather than push it back.
 */

/** A remote ads row, as the local store wants it. */
export const adFromRow = (row) => ({
  id: row.archive_id,
  pageName: row.advertiser || null,
  pageId: row.page_id || null,
  startDate: row.started_at ? Date.parse(row.started_at) : null,
  endDate: row.ended_at ? Date.parse(row.ended_at) : null,
  isActive: row.is_active,
  ctaText: row.cta || null,
  linkUrl: row.link || null,
  body: row.body || null,
  media: (row.raw && row.raw.media) || [],
  platforms: (row.raw && row.raw.platforms) || [],
  collationCount: (row.raw && row.raw.collationCount) ?? null,
  libraryUrl:
    (row.raw && row.raw.libraryUrl) ||
    `https://www.facebook.com/ads/library/?id=${row.archive_id}`,
  savedBy: (row.raw && row.raw.savedBy) || null,
  savedAt: row.created_at ? Date.parse(row.created_at) : Date.now(),
  remoteUpdatedAt: row.updated_at ? Date.parse(row.updated_at) : 0,
});

/** A local ad, as the remote table wants it. */
export const rowFromAd = (ad, teamId) => ({
  team_id: teamId,
  archive_id: String(ad.id),
  advertiser: ad.pageName || null,
  page_id: ad.pageId ? String(ad.pageId) : null,
  started_at: ad.startDate ? new Date(ad.startDate).toISOString() : null,
  ended_at: ad.endDate ? new Date(ad.endDate).toISOString() : null,
  is_active: typeof ad.isActive === "boolean" ? ad.isActive : null,
  format: ad.format || null,
  cta: ad.ctaText || null,
  link: ad.linkUrl || null,
  body: ad.body || null,
  // Signed CDN links expire in hours, so these travel as a convenience for a
  // download that happens soon after, never as an archive.
  thumb_url: (ad.media && ad.media[0] && ad.media[0].previewUrl) || null,
  hd_url: (ad.media && ad.media[0] && ad.media[0].hdUrl) || null,
  raw: {
    media: ad.media || [],
    platforms: ad.platforms || [],
    collationCount: ad.collationCount ?? null,
    libraryUrl: ad.libraryUrl || null,
    savedBy: ad.savedBy || null,
  },
  deleted_at: null,
});

/**
 * Fold remote ad rows into the local ads map.
 *
 * The thumbnail is the one thing the local copy knows better: it is a data URL
 * captured at save time, and it does not travel, so it must survive a merge
 * that would otherwise overwrite the record wholesale.
 */
export const mergeAds = (localAds, rows) => {
  const ads = { ...localAds };
  const removed = [];

  for (const row of rows) {
    const id = row.archive_id;
    if (row.deleted_at) {
      if (ads[id]) {
        delete ads[id];
        removed.push(id);
      }
      continue;
    }
    const incoming = adFromRow(row);
    const existing = ads[id];
    ads[id] = existing
      ? { ...existing, ...incoming, thumbDataUrl: existing.thumbDataUrl }
      : incoming;
  }

  return { ads, removed };
};

/**
 * Fold remote lists and their memberships into the local lists map.
 *
 * Membership is replaced rather than unioned for the lists that came back:
 * the remote row set is the truth for a team space, and unioning would make a
 * removal impossible to propagate.
 */
export const mergeLists = ({
  localLists,
  spaceId,
  listRows,
  listAdRows,
  knownAdIds,
}) => {
  const lists = { ...localLists };
  const byRemote = new Map();
  for (const list of Object.values(lists))
    if (list.remoteId) byRemote.set(list.remoteId, list);

  const removed = [];

  for (const row of listRows) {
    const existing = byRemote.get(row.id);
    if (row.deleted_at) {
      if (existing) {
        delete lists[existing.id];
        removed.push(existing.id);
      }
      continue;
    }
    if (existing) {
      lists[existing.id] = {
        ...existing,
        name: row.name,
        color: row.colour,
        remoteId: row.id,
      };
    } else {
      // A list created by a teammate: adopt the remote id as the local one so
      // the two stay in step without a second mapping to keep.
      lists[row.id] = {
        id: row.id,
        spaceId,
        name: row.name,
        color: row.colour,
        adIds: [],
        createdAt: row.created_at ? Date.parse(row.created_at) : Date.now(),
        remoteId: row.id,
      };
    }
  }

  // Membership, per list that came back in this pull.
  const touched = new Set();
  const members = new Map();
  for (const row of listAdRows) {
    touched.add(row.list_id);
    if (row.deleted_at) continue;
    if (!members.has(row.list_id)) members.set(row.list_id, []);
    members.get(row.list_id).push(row.archive_id);
  }

  for (const remoteListId of touched) {
    const local = Object.values(lists).find((l) => l.remoteId === remoteListId);
    if (!local) continue;
    const ids = (members.get(remoteListId) || []).filter(
      (id) => !knownAdIds || knownAdIds.has(id),
    );
    lists[local.id] = { ...local, adIds: [...new Set(ids)] };
  }

  return { lists, removed };
};

/**
 * The high-water mark for the next pull.
 *
 * One second is subtracted because rows written inside the same second as the
 * last pull can land after it, and re-reading a handful of rows is free while
 * missing one is not.
 */
export const nextCursor = (rows, previous) => {
  let newest = 0;
  for (const row of rows) {
    const at = Date.parse(row.updated_at || row.created_at || 0);
    if (Number.isFinite(at) && at > newest) newest = at;
  }
  // Nothing came back, so the mark stands. Subtracting the overlap here would
  // walk the cursor backwards a second on every quiet poll, and a space that
  // sat idle would re-fetch further and further history each time.
  if (!newest) return previous || null;

  const moved = new Date(newest - 1000).toISOString();
  if (!previous) return moved;
  // And never let the overlap drag the mark behind where it already was.
  return Date.parse(moved) > Date.parse(previous) ? moved : previous;
};

/**
 * Fold remote canvases into the local canvases map.
 *
 * Simpler than lists in one way that matters: canvas, node and edge ids are
 * uuids generated on the client, so a local id is already the remote id and
 * there is no mapping to carry back. `link_lists` exists only because lists
 * were not built that way.
 *
 * Remote is the truth for a canvas that came back, nodes and edges included:
 * unioning them would make moving or removing a node impossible to propagate,
 * and the node text is the whole point of the feature. A canvas the pull did
 * not mention is left exactly as it is.
 */
export const mergeCanvases = ({ localCanvases, spaceId, canvasRows, nodeRows, edgeRows }) => {
  const canvases = { ...localCanvases };
  const removed = [];

  const nodesByCanvas = new Map();
  for (const row of nodeRows || []) {
    if (row.deleted_at) continue;
    if (!nodesByCanvas.has(row.canvas_id)) nodesByCanvas.set(row.canvas_id, []);
    nodesByCanvas.get(row.canvas_id).push({
      id: row.id,
      kind: row.kind,
      adId: row.archive_id || null,
      note: row.note || "",
      snapshot: row.snapshot || {},
      x: row.x,
      y: row.y,
    });
  }

  const edgesByCanvas = new Map();
  for (const row of edgeRows || []) {
    if (row.deleted_at) continue;
    if (!edgesByCanvas.has(row.canvas_id)) edgesByCanvas.set(row.canvas_id, []);
    edgesByCanvas.get(row.canvas_id).push({ from: row.from_node, to: row.to_node });
  }

  for (const row of canvasRows || []) {
    if (row.deleted_at) {
      if (canvases[row.id]) {
        delete canvases[row.id];
        removed.push(row.id);
      }
      continue;
    }
    const local = canvases[row.id];
    canvases[row.id] = {
      id: row.id,
      spaceId,
      name: row.name,
      // A canvas whose rows have not arrived yet keeps whatever it had, rather
      // than rendering as an empty graph somebody then edits over the top of.
      nodes: nodesByCanvas.get(row.id) || (local ? local.nodes : []),
      edges: edgesByCanvas.get(row.id) || (local ? local.edges : []),
      createdAt: row.created_at ? Date.parse(row.created_at) : Date.now(),
      updatedAt: row.updated_at ? Date.parse(row.updated_at) : Date.now(),
    };
  }

  return { canvases, removed };
};

/** The rows one local canvas becomes. */
export const rowsFromCanvas = (canvas, teamId, userId) => ({
  canvas: {
    id: canvas.id,
    team_id: teamId,
    name: canvas.name,
    created_by: userId,
    deleted_at: null,
  },
  nodes: (canvas.nodes || []).map((node) => ({
    id: node.id,
    canvas_id: canvas.id,
    kind: node.kind,
    // The check constraint ties archive_id to kind: a reference must name an
    // ad, and a note or output must not carry one.
    archive_id: node.kind === "reference" ? node.adId || null : null,
    note: node.note || "",
    snapshot: node.snapshot || {},
    x: Math.round(node.x || 0),
    y: Math.round(node.y || 0),
    created_by: userId,
    deleted_at: null,
  })),
  edges: (canvas.edges || []).map((edge) => ({
    canvas_id: canvas.id,
    from_node: edge.from,
    to_node: edge.to,
    created_by: userId,
    deleted_at: null,
  })),
});
