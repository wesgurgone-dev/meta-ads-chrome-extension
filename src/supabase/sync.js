/**
 * Team-space sync.
 *
 * The network half. Everything that decides what the library ends up looking
 * like is in merge.js, which is pure and tested on its own; this file fetches
 * rows, hands them to those rules, and writes the result back through the
 * service worker so storage stays owned in one place.
 *
 * It runs in the dashboard page rather than the service worker for two
 * reasons: the worker is not bundled, so it cannot import supabase-js, and a
 * worker is killed after about thirty seconds of idle, which is no place for a
 * realtime socket.
 */
import { getClient, getSession } from "./client.js";
import {
  mergeAds,
  mergeCanvases,
  mergeLists,
  nextCursor,
  rowFromAd,
  rowsFromCanvas,
} from "./merge.js";

const CURSORS = "syncCursors";

const send = (msg) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError)
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res || { ok: false });
    });
  });

const readCursor = async (teamId) => {
  const got = await chrome.storage.local.get(CURSORS);
  return (got[CURSORS] || {})[teamId] || null;
};

const writeCursor = async (teamId, cursor) => {
  const got = await chrome.storage.local.get(CURSORS);
  const all = got[CURSORS] || {};
  all[teamId] = cursor;
  await chrome.storage.local.set({ [CURSORS]: all });
};

/** Six characters, no vowels, so a code cannot spell anything unfortunate. */
const makeCode = () => {
  const alphabet = "BCDFGHJKLMNPQRSTVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++)
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
};

const requireClient = async () => {
  const supabase = await getClient();
  if (!supabase) throw new Error("Supabase is not configured yet.");
  const session = await getSession();
  if (!session) throw new Error("Sign in first.");
  return { supabase, session };
};

/** Turn a local space into a team, or adopt one that already exists. */
export const createTeam = async (spaceId, name) => {
  try {
    const { supabase, session } = await requireClient();
    const { data, error } = await supabase
      .from("teams")
      .insert({ name, join_code: makeCode(), owner_id: session.user.id })
      .select()
      .single();
    if (error) return { ok: false, error: error.message };
    await send({ type: "SPACE_OP", op: "link", spaceId, teamId: data.id, code: data.join_code });
    return { ok: true, team: data };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
};

/**
 * A brand new team space, rather than converting the one you are standing in.
 *
 * Converting was the only route before, and it had a trap: once the active
 * space was linked, the option disappeared and there was no way to make a
 * second team at all. Creating a fresh space has no such state to be in, and it
 * is also what "make a team space" sounds like it should do - the personal
 * library stays personal.
 */
export const createTeamSpace = async (name) => {
  const created = await send({ type: "SPACE_OP", op: "create", name, kind: "team" });
  if (!created || !created.ok)
    return { ok: false, error: (created && created.error) || "Could not create the space." };

  const team = await createTeam(created.space.id, name);
  if (!team.ok) {
    // The local space exists and is usable; it just is not shared yet. Say so
    // rather than leaving a team space that silently never syncs.
    return { ok: false, error: `${team.error} The space was created locally.` };
  }
  return { ok: true, team: team.team, space: created.space };
};

/**
 * Join a team into a new space, for when the space you are standing in already
 * belongs to one. Joining in place would silently re-point it at a different
 * team and strand everything already synced to the first.
 */
export const joinTeamSpace = async (code) => {
  const created = await send({ type: "SPACE_OP", op: "create", name: "Team space", kind: "team" });
  if (!created || !created.ok)
    return { ok: false, error: (created && created.error) || "Could not create the space." };
  const joined = await joinTeam(created.space.id, code);
  if (!joined.ok) return joined;
  if (joined.team && joined.team.name)
    await send({ type: "SPACE_OP", op: "rename", spaceId: created.space.id, name: joined.team.name });
  return { ...joined, space: created.space };
};

export const joinTeam = async (spaceId, code) => {
  try {
    const { supabase } = await requireClient();
    const { data, error } = await supabase.rpc("join_team", { code });
    if (error) return { ok: false, error: error.message };
    const team = Array.isArray(data) ? data[0] : data;
    await send({ type: "SPACE_OP", op: "link", spaceId, teamId: team.id, code: team.join_code });
    return { ok: true, team };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
};


/**
 * Canvases, nodes and edges.
 *
 * Ids are uuids generated on the client, so a local id is already the remote id
 * and nothing has to be mapped back. What does need care is removal: deleting a
 * node locally deletes the object, so there is no tombstone to push. The rows
 * that are still here are upserted, and every other row on that canvas is
 * marked deleted - which is also what stops a teammate's device helpfully
 * re-inserting a node somebody removed.
 */
const pushCanvases = async (supabase, session, space) => {
  const { canvases = {} } = await chrome.storage.local.get("canvases");
  const mine = Object.values(canvases).filter((c) => c.spaceId === space.id);
  if (!mine.length) return { count: 0 };

  for (const canvas of mine) {
    const rows = rowsFromCanvas(canvas, space.teamId, session.user.id);

    const { error: canvasError } = await supabase
      .from("canvases")
      .upsert(rows.canvas, { onConflict: "id" });
    if (canvasError) return { error: canvasError.message };

    if (rows.nodes.length) {
      const { error } = await supabase
        .from("canvas_nodes")
        .upsert(rows.nodes, { onConflict: "id" });
      if (error) return { error: error.message };
    }

    // Anything on this canvas that is no longer here is gone on purpose.
    const keep = rows.nodes.map((n) => n.id);
    const staleNodes = supabase
      .from("canvas_nodes")
      .update({ deleted_at: new Date().toISOString() })
      .eq("canvas_id", canvas.id)
      .is("deleted_at", null);
    const { error: reapError } = await (keep.length
      ? staleNodes.not("id", "in", `(${keep.join(",")})`)
      : staleNodes);
    if (reapError) return { error: reapError.message };

    if (rows.edges.length) {
      const { error } = await supabase
        .from("canvas_edges")
        .upsert(rows.edges, { onConflict: "from_node,to_node" });
      if (error) return { error: error.message };
    }
    const keptEdges = rows.edges.map((e) => e.from_node);
    const staleEdges = supabase
      .from("canvas_edges")
      .update({ deleted_at: new Date().toISOString() })
      .eq("canvas_id", canvas.id)
      .is("deleted_at", null);
    const { error: edgeReapError } = await (keptEdges.length
      ? staleEdges.not("from_node", "in", `(${[...new Set(keptEdges)].join(",")})`)
      : staleEdges);
    if (edgeReapError) return { error: edgeReapError.message };
  }

  return { count: mine.length };
};

/** Fetch the canvases that moved, and their children. */
const pullCanvases = async (supabase, space, since) => {
  let query = supabase.from("canvases").select("*").eq("team_id", space.teamId);
  if (since) query = query.gt("updated_at", since);
  const { data, error } = await query;
  if (error) return { error: error.message };
  if (!data.length) return { rows: [], nodes: [], edges: [] };

  const ids = data.map((c) => c.id);
  // Nodes and edges are read per canvas that came back, not filtered by time:
  // a node write touches its canvas, so the canvas is the cursor for all three.
  const [nodes, edges] = await Promise.all([
    supabase.from("canvas_nodes").select("*").in("canvas_id", ids),
    supabase.from("canvas_edges").select("*").in("canvas_id", ids),
  ]);
  if (nodes.error) return { error: nodes.error.message };
  if (edges.error) return { error: edges.error.message };
  return { rows: data, nodes: nodes.data, edges: edges.data };
};

/**
 * Send everything in the space up.
 *
 * Ads upsert onto (team_id, archive_id), so a creative two people saved is one
 * row. Lists are matched on the remote id they already carry, and the ids that
 * come back are stored so the next push updates rather than duplicates.
 */
export const push = async (space, lists, ads) => {
  try {
    const { supabase, session } = await requireClient();
    if (!space.teamId) return { ok: false, error: "This space is not linked to a team yet." };

    const spaceLists = lists.filter((l) => l.spaceId === space.id);
    const adIds = new Set();
    for (const l of spaceLists) for (const id of l.adIds || []) adIds.add(id);
    const toPush = [...adIds].map((id) => ads[id]).filter(Boolean);

    let pushedAds = 0;
    if (toPush.length) {
      const { data, error } = await supabase
        .from("ads")
        .upsert(toPush.map((ad) => rowFromAd(ad, space.teamId)), {
          onConflict: "team_id,archive_id",
        })
        .select("id,archive_id");
      if (error) return { ok: false, error: error.message };
      pushedAds = data.length;
      var remoteAdId = new Map(data.map((r) => [r.archive_id, r.id]));
    } else {
      var remoteAdId = new Map();
    }

    const linked = [];
    for (const list of spaceLists) {
      const row = {
        team_id: space.teamId,
        name: list.name,
        colour: list.color,
        created_by: session.user.id,
        deleted_at: null,
      };
      if (list.remoteId) row.id = list.remoteId;
      const { data, error } = await supabase
        .from("lists")
        .upsert(row, { onConflict: "id" })
        .select("id")
        .single();
      if (error) return { ok: false, error: error.message };
      linked.push({ localId: list.id, remoteId: data.id });

      const members = (list.adIds || [])
        .map((archiveId) => remoteAdId.get(archiveId))
        .filter(Boolean)
        .map((adId) => ({
          list_id: data.id,
          ad_id: adId,
          added_by: session.user.id,
          deleted_at: null,
        }));
      if (members.length) {
        const { error: memberError } = await supabase
          .from("list_ads")
          .upsert(members, { onConflict: "list_id,ad_id" });
        if (memberError) return { ok: false, error: memberError.message };
      }
    }

    await send({ type: "SPACE_OP", op: "link_lists", links: linked });

    const pushedCanvases = await pushCanvases(supabase, session, space);
    if (pushedCanvases.error) return { ok: false, error: pushedCanvases.error };

    return {
      ok: true,
      ads: pushedAds,
      lists: linked.length,
      canvases: pushedCanvases.count,
    };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
};

/** Fetch what changed since the last pull and fold it in. */
export const pull = async (space, localLists, localAds) => {
  try {
    const { supabase } = await requireClient();
    if (!space.teamId) return { ok: false, error: "This space is not linked to a team yet." };

    const since = await readCursor(space.teamId);
    const sinceFilter = (q) => (since ? q.gt("updated_at", since) : q);

    const [adsRes, listsRes] = await Promise.all([
      sinceFilter(supabase.from("ads").select("*").eq("team_id", space.teamId)),
      sinceFilter(supabase.from("lists").select("*").eq("team_id", space.teamId)),
    ]);
    if (adsRes.error) return { ok: false, error: adsRes.error.message };
    if (listsRes.error) return { ok: false, error: listsRes.error.message };

    // Membership has no updated_at of its own, so it is read per list that
    // came back rather than filtered by time.
    const listIds = listsRes.data.map((l) => l.id);
    let listAdRows = [];
    if (listIds.length) {
      const { data, error } = await supabase
        .from("list_ads")
        .select("list_id,ad_id,deleted_at,ads(archive_id)")
        .in("list_id", listIds);
      if (error) return { ok: false, error: error.message };
      listAdRows = data.map((r) => ({
        list_id: r.list_id,
        archive_id: r.ads ? r.ads.archive_id : null,
        deleted_at: r.deleted_at,
      }));
    }

    const { ads, removed } = mergeAds(localAds, adsRes.data);
    const { lists } = mergeLists({
      localLists,
      spaceId: space.id,
      listRows: listsRes.data,
      listAdRows,
      knownAdIds: new Set(Object.keys(ads)),
    });

    await send({ type: "APPLY_SYNC", spaceId: space.id, ads, lists });

    const canvasRes = await pullCanvases(supabase, space, since);
    if (canvasRes.error) return { ok: false, error: canvasRes.error };
    if (canvasRes.rows.length) {
      const { canvases = {} } = await chrome.storage.local.get("canvases");
      const merged = mergeCanvases({
        localCanvases: canvases,
        spaceId: space.id,
        canvasRows: canvasRes.rows,
        nodeRows: canvasRes.nodes,
        edgeRows: canvasRes.edges,
      });
      await send({ type: "APPLY_CANVAS_SYNC", canvases: merged.canvases });
    }

    await writeCursor(
      space.teamId,
      nextCursor([...adsRes.data, ...listsRes.data, ...canvasRes.rows], since),
    );

    return {
      ok: true,
      ads: adsRes.data.length,
      lists: listsRes.data.length,
      canvases: canvasRes.rows.length,
      removed: removed.length,
    };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
};

/**
 * Watch a team for changes.
 *
 * Lives in a page, never in the service worker: a worker is killed after about
 * thirty seconds of idle and would take the socket with it. A pull runs on
 * every wake regardless, because a socket that was closed while the page was
 * shut cannot tell you what it missed.
 */
export const watch = async (space, onChange) => {
  const supabase = await getClient();
  if (!supabase || !space.teamId) return () => {};

  const channel = supabase
    .channel(`team:${space.teamId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "ads", filter: `team_id=eq.${space.teamId}` },
      onChange,
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "lists", filter: `team_id=eq.${space.teamId}` },
      onChange,
    )
    // Canvases only. Node and edge changes touch their canvas, so one
    // subscription covers all three.
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "canvases", filter: `team_id=eq.${space.teamId}` },
      onChange,
    )
    .subscribe();

  return () => supabase.removeChannel(channel);
};
