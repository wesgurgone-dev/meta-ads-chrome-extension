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
import { mergeAds, mergeLists, nextCursor, rowFromAd } from "./merge.js";

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
    return { ok: true, ads: pushedAds, lists: linked.length };
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
    await writeCursor(
      space.teamId,
      nextCursor([...adsRes.data, ...listsRes.data], since),
    );

    return {
      ok: true,
      ads: adsRes.data.length,
      lists: listsRes.data.length,
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
    .subscribe();

  return () => supabase.removeChannel(channel);
};
