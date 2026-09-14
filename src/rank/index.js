/**
 * Scoring one ad.
 *
 * The call runs in the dashboard page, not the service worker, for the same two
 * reasons sync does: the worker is unbundled so it cannot import supabase-js,
 * and it dies after about thirty seconds idle, which is no place to await a
 * reasoning model looking at eight images.
 *
 * The Anthropic key is never here. Every call goes through the Edge Function in
 * supabase/functions/claude, which holds the key, checks the caller is a signed
 * in member of the team they name, and meters them.
 *
 * Scores are cached on (ad, rubric version) in two places: locally always, and
 * in the team when there is one, so a teammate's spend benefits everyone. The
 * cache is the whole reason this is affordable - nothing here may ever be
 * called from a render path.
 */
import { ask, MODEL } from "../supabase/ai.js";
import { getClient } from "../supabase/client.js";
import { RUBRIC, RUBRIC_VERSION } from "./rubric.js";
import { SCORE_SCHEMA, validateScore, overallScore } from "./schema.js";

const MAX_FRAMES = 8;

const send = (msg) =>
  new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => resolve(res || { ok: false }));
    } catch (err) {
      resolve({ ok: false, error: String(err && err.message) });
    }
  });

/** Strip the data: prefix; the API takes raw base64 plus a media type. */
const splitDataUrl = (dataUrl) => {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl || "");
  if (!match || !match[2]) return null;
  return { mediaType: match[1] || "image/jpeg", data: match[3] };
};

/**
 * The ad's own words. This is the cheapest available fix for the utility axis
 * being weak on frames alone, and it costs a few hundred tokens.
 */
export const adFacts = (ad) => {
  const lines = [
    `Advertiser: ${ad.pageName || "unknown"}`,
    ad.title ? `Headline: ${ad.title}` : null,
    ad.body ? `Body copy: ${ad.body}` : null,
    ad.caption ? `Caption: ${ad.caption}` : null,
    ad.linkDescription ? `Link description: ${ad.linkDescription}` : null,
    ad.ctaText ? `Call to action: ${ad.ctaText}` : null,
    ad.linkUrl ? `Destination: ${ad.linkUrl}` : null,
    ad.platforms && ad.platforms.length ? `Platforms: ${ad.platforms.join(", ")}` : null,
    ad.startDate ? `Running since: ${ad.startDate}` : null,
  ].filter(Boolean);
  return lines.join("\n");
};

/** Sampled frames, or the single stored thumbnail for a still ad. */
export const collectImages = async (ad) => {
  const res = await send({ type: "FRAMES_GET", adId: ad.id });
  const record = res && res.frames;
  if (record && record.frames && record.frames.length) {
    return {
      kind: "video",
      images: record.frames.slice(0, MAX_FRAMES).map((f, i) => ({
        label: `Frame ${i} at ${f.t.toFixed(1)}s`,
        ...splitDataUrl(f.dataUrl),
      })).filter((f) => f.data),
      note: null,
    };
  }
  if (ad.thumbDataUrl) {
    const parsed = splitDataUrl(ad.thumbDataUrl);
    if (parsed)
      return {
        kind: "still",
        images: [{ label: "Frame 0, the creative", ...parsed }],
        note:
          record && record.error
            ? `Video frames could not be captured (${record.error}); scoring the still only.`
            : null,
      };
  }
  return { kind: "none", images: [], note: (record && record.error) || null };
};

const TASK = `Score this ad now. Follow the rubric exactly: evidence, then frame index, then band, then score, for each of the four axes. Frame indices refer to the labelled frames above.`;

/**
 * Score one ad. Returns { ok, score } or { ok: false, error }.
 *
 * `force` skips the cache; nothing else does.
 */
export const scoreAd = async (ad, { teamId = null, force = false, model = MODEL } = {}) => {
  if (!ad || !ad.id) return { ok: false, error: "No ad." };

  if (!force) {
    const cached = await readCache(ad.id, teamId);
    if (cached) return { ok: true, score: cached, cached: true };
  }

  const { kind, images, note } = await collectImages(ad);
  if (!images.length)
    return {
      ok: false,
      error: note
        ? `Nothing to look at: ${note}`
        : "No frames or thumbnail for this ad, so there is nothing to score.",
    };

  const content = [{ type: "text", text: adFacts(ad) }];
  if (note) content.push({ type: "text", text: note });
  for (const img of images) {
    content.push({ type: "text", text: img.label });
    content.push({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.data },
    });
  }
  content.push({ type: "text", text: TASK });

  const res = await ask({
    model,
    // Blocks, not a string: cache_control is what makes the frozen rubric a
    // cached prefix instead of a few thousand tokens paid for on every ad.
    system: [{ type: "text", text: RUBRIC, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content }],
    // Thinking is on by default and counts against max_tokens, so a ceiling
    // written for a thinking-off model truncates mid-JSON.
    maxTokens: 4000,
    outputConfig: { effort: "medium", format: { type: "json_schema", schema: SCORE_SCHEMA } },
    teamId,
  });
  if (!res.ok) return res;

  if (res.stop_reason === "refusal")
    return { ok: false, error: "The model declined to score this ad." };

  const text = (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: "The model did not return the expected JSON." };
  }

  const check = validateScore(parsed);
  const score = {
    adId: ad.id,
    rubricVersion: RUBRIC_VERSION,
    model,
    axes: parsed.axes,
    overall: overallScore(parsed.axes),
    frames: images.length,
    frameKind: kind,
    usage: res.usage || null,
    // A band that disagrees with its score is a rubric problem, and it travels
    // with the row rather than being retried away.
    problems: check.ok ? null : check.problems,
    createdAt: Date.now(),
  };

  await writeCache(score, teamId);
  return { ok: true, score };
};

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const readCache = async (adId, teamId) => {
  const local = await send({ type: "SCORES_GET", adIds: [adId] });
  const hit = local && local.scores && local.scores[adId];
  if (hit && hit.rubricVersion === RUBRIC_VERSION) return hit;

  if (!teamId) return null;
  const supabase = await getClient();
  if (!supabase) return null;
  const { data } = await supabase
    .from("ad_scores")
    .select("*")
    .eq("team_id", teamId)
    .eq("archive_id", adId)
    .eq("rubric_version", RUBRIC_VERSION)
    .maybeSingle();
  if (!data) return null;
  const score = rowToScore(data);
  await send({ type: "SCORE_SAVE", score });
  return score;
};

const writeCache = async (score, teamId) => {
  await send({ type: "SCORE_SAVE", score });
  if (!teamId) return;
  const supabase = await getClient();
  if (!supabase) return;
  await supabase.from("ad_scores").upsert(scoreToRow(score, teamId), {
    onConflict: "team_id,archive_id,rubric_version",
  });
};

export const rowToScore = (row) => ({
  adId: row.archive_id,
  rubricVersion: row.rubric_version,
  model: row.model,
  axes: row.axes,
  overall: overallScore(row.axes),
  frames: row.frames,
  frameKind: row.frame_kind,
  usage: row.usage,
  problems: row.problems,
  createdAt: row.created_at ? Date.parse(row.created_at) : Date.now(),
});

export const scoreToRow = (score, teamId) => ({
  team_id: teamId,
  archive_id: score.adId,
  rubric_version: score.rubricVersion,
  model: score.model,
  axes: score.axes,
  frames: score.frames,
  frame_kind: score.frameKind,
  usage: score.usage,
  problems: score.problems,
});

export { RUBRIC_VERSION, overallScore };
