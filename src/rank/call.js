/**
 * Scoring one ad, end to end, with no dependencies.
 *
 * This file runs in the service worker, which is why it imports nothing but the
 * rubric and the schema: the worker is not bundled, so supabase-js is not
 * available to it and never will be. Everything here is plain fetch.
 *
 * That constraint bought something worth having. Scoring used to run in the
 * dashboard page, which meant an ad was only ever scored if somebody opened the
 * dashboard and clicked a button. Now the worker scores every ad as it is saved,
 * whatever page the save came from, and the page only reads the result.
 *
 * The Anthropic key is not here either. The call goes to the Edge Function that
 * holds it; this file has the caller's own Supabase session token and nothing
 * more.
 */
import { RUBRIC, RUBRIC_VERSION } from "./rubric.js";
import { SCORE_SCHEMA, overallScore, validateScore } from "./schema.js";

/**
 * Sonnet 5 rather than Opus 5, chosen for cost.
 *
 * One thing changes with it that is invisible until the bill arrives: the
 * minimum cacheable prefix is 1024 tokens on Sonnet 5, against 512 on Opus 5,
 * and the rubric sits close to that line. Under it, the cached system block
 * silently stops caching - no error, just `cache_read_input_tokens: 0` and the
 * rubric paid for in full on every ad. The score record keeps the cache numbers
 * so this is checkable on the first few real scores rather than assumed.
 */
export const MODEL = "claude-sonnet-5";
const MAX_FRAMES = 5;

/**
 * The ad's own words. The cheapest available fix for the utility axis being
 * weak on frames alone, and it costs a few hundred tokens.
 */
export const adFacts = (ad) =>
  [
    `Advertiser: ${ad.pageName || "unknown"}`,
    ad.title ? `Headline: ${ad.title}` : null,
    ad.body ? `Body copy: ${ad.body}` : null,
    ad.caption ? `Caption: ${ad.caption}` : null,
    ad.linkDescription ? `Link description: ${ad.linkDescription}` : null,
    ad.ctaText ? `Call to action: ${ad.ctaText}` : null,
    ad.linkUrl ? `Destination: ${ad.linkUrl}` : null,
    ad.platforms && ad.platforms.length ? `Platforms: ${ad.platforms.join(", ")}` : null,
    ad.startDate ? `Running since: ${new Date(ad.startDate).toISOString().slice(0, 10)}` : null,
  ]
    .filter(Boolean)
    .join("\n");

/** Strip the data: prefix; the API takes raw base64 plus a media type. */
export const splitDataUrl = (dataUrl) => {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl || "");
  if (!match) return null;
  return { mediaType: match[1] || "image/jpeg", data: match[2] };
};

/**
 * What there is to look at: sampled video frames, or the one stored thumbnail.
 * An ad scored from a single still is a weaker measurement than one scored from
 * eight frames, so which it was travels with the score rather than being lost.
 */
export const collectImages = (ad, frameRecord) => {
  if (frameRecord && frameRecord.frames && frameRecord.frames.length) {
    const images = frameRecord.frames
      .slice(0, MAX_FRAMES)
      .map((f, i) => ({ label: `Frame ${i} at ${f.t.toFixed(1)}s`, ...splitDataUrl(f.dataUrl) }))
      .filter((f) => f.data);
    if (images.length) return { kind: "video", images, note: null };
  }
  if (ad.thumbDataUrl) {
    const parsed = splitDataUrl(ad.thumbDataUrl);
    if (parsed)
      return {
        kind: "still",
        images: [{ label: "Frame 0, the creative", ...parsed }],
        note:
          frameRecord && frameRecord.error
            ? `Video frames could not be captured (${frameRecord.error}); scoring the still only.`
            : null,
      };
  }
  return { kind: "none", images: [], note: (frameRecord && frameRecord.error) || null };
};

const TASK =
  "Score this ad now. Follow the rubric exactly: evidence, then frame index, then band, then score, for each of the four axes. Frame indices refer to the labelled frames above.";

export const buildMessages = (ad, { images, note }) => {
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
  return [{ role: "user", content }];
};

/**
 * Why a scoring attempt failed, as a code rather than a sentence.
 *
 * The queue treats these very differently: a missing deployment or an expired
 * session means stop and wait, while a bad ad means drop this one and carry on.
 * A string like "Request failed (404)" cannot express that difference, which is
 * exactly what it looked like from the UI.
 */
export const FAILURE = {
  NOT_DEPLOYED: "not_deployed",
  SIGNED_OUT: "signed_out",
  RATE_LIMITED: "rate_limited",
  NOTHING_TO_SEE: "nothing_to_see",
  UPSTREAM: "upstream",
  BAD_REPLY: "bad_reply",
  OFFLINE: "offline",
};

/** Whether the whole queue should stop, or just this job be dropped. */
export const isBlocking = (code) =>
  code === FAILURE.NOT_DEPLOYED ||
  code === FAILURE.SIGNED_OUT ||
  code === FAILURE.RATE_LIMITED ||
  code === FAILURE.OFFLINE;

export const failureMessage = (code, detail) => {
  switch (code) {
    case FAILURE.NOT_DEPLOYED:
      return "The scoring function is not deployed yet. Run: supabase functions deploy claude";
    case FAILURE.SIGNED_OUT:
      // Two different fixes, and which one applies is the project owner's
      // choice rather than something this end can work out.
      return "The scoring function refused the request. Either sign in under Settings, or allow signed-out use: supabase secrets set ALLOW_ANON=true";
    case FAILURE.RATE_LIMITED:
      return "The daily scoring limit has been reached.";
    case FAILURE.NOTHING_TO_SEE:
      return detail
        ? `Nothing to look at: ${detail}`
        : "No frames or thumbnail for this ad, so there is nothing to score.";
    case FAILURE.OFFLINE:
      return "Could not reach the scoring function.";
    case FAILURE.BAD_REPLY:
      return "The model did not return the expected result.";
    default:
      return detail || "Scoring failed.";
  }
};

/**
 * Score one ad. Returns { ok: true, score } or { ok: false, code, detail }.
 *
 * `url` and `token` are the Supabase project URL and the caller's access token,
 * both read from storage by the worker.
 */
export const scoreAd = async (
  ad,
  { frames, url, anonKey, token, teamId = null, model = MODEL, fast = false },
) => {
  const startedAt = Date.now();
  const seen = collectImages(ad, frames);
  if (!seen.images.length)
    return { ok: false, code: FAILURE.NOTHING_TO_SEE, detail: seen.note };
  if (!url) return { ok: false, code: FAILURE.SIGNED_OUT };
  // Signed out, the publishable key is the credential. The function only
  // honours it when its own ALLOW_ANON secret is set, so this cannot widen
  // access from the client side.
  const bearer = token || anonKey;
  if (!bearer) return { ok: false, code: FAILURE.SIGNED_OUT };

  let res;
  try {
    res = await fetch(`${url}/functions/v1/claude`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${bearer}`,
        apikey: anonKey || "",
      },
      body: JSON.stringify({
        model,
        // Blocks, not a string: cache_control is what makes the frozen rubric a
        // cached prefix instead of a few thousand tokens paid for per ad.
        system: [{ type: "text", text: RUBRIC, cache_control: { type: "ephemeral" } }],
        messages: buildMessages(ad, seen),
        // Thinking is on by default on this model and counts against the
        // ceiling, so this is sized for a short reasoning pass plus the JSON -
        // not for the JSON alone, which would truncate mid-object.
        max_tokens: 1500,
        thinking: { type: "adaptive" },
        // Low, not medium. This is a bounded judgement against a rubric that
        // already does the reasoning: the anchors, the band-before-number
        // ordering and the anti-7 rule are what hold the scale, not thinking
        // depth. Effort is the difference between a score arriving while the
        // user is still looking at the ad and arriving a minute later.
        output_config: { effort: "low", format: { type: "json_schema", schema: SCORE_SCHEMA } },
        // Same model, up to 2.5x the output rate, at premium pricing. Off by
        // default because it costs double.
        ...(fast ? { fast: true } : {}),
        teamId,
      }),
    });
  } catch (err) {
    return { ok: false, code: FAILURE.OFFLINE, detail: String(err && err.message) };
  }

  if (res.status === 404) return { ok: false, code: FAILURE.NOT_DEPLOYED };
  if (res.status === 401 || res.status === 403)
    return { ok: false, code: FAILURE.SIGNED_OUT };
  if (res.status === 429) return { ok: false, code: FAILURE.RATE_LIMITED };

  const text = await res.text();
  if (!res.ok) {
    let detail = `Request failed (${res.status})`;
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.error) detail = parsed.error;
    } catch (err) {
      /* not JSON; the status is all there is */
    }
    return { ok: false, code: FAILURE.UPSTREAM, detail };
  }

  let reply;
  try {
    reply = JSON.parse(text);
  } catch (err) {
    return { ok: false, code: FAILURE.BAD_REPLY };
  }
  if (reply.stop_reason === "refusal")
    return { ok: false, code: FAILURE.BAD_REPLY, detail: "The model declined to score this ad." };

  let parsed;
  try {
    parsed = JSON.parse(
      (reply.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join(""),
    );
  } catch (err) {
    return { ok: false, code: FAILURE.BAD_REPLY };
  }

  const check = validateScore(parsed);
  return {
    ok: true,
    score: {
      adId: ad.id,
      rubricVersion: RUBRIC_VERSION,
      model,
      axes: parsed.axes,
      overall: overallScore(parsed.axes),
      frames: seen.images.length,
      frameKind: seen.kind,
      usage: reply.usage || null,
      // Whether the rubric was served from cache. See MODEL above: on Sonnet 5
      // a prefix under 1024 tokens fails to cache silently.
      cached: (reply.usage && reply.usage.cache_read_input_tokens) || 0,
      // How long the call itself took. "Scoring is slow" is otherwise an
      // impression; this makes it a number, and separates the model's time
      // from the frame extraction that runs before it.
      ms: Date.now() - startedAt,
      // A band that disagrees with its score is a rubric problem, and it travels
      // with the row rather than being retried away.
      problems: check.ok ? null : check.problems,
      createdAt: Date.now(),
    },
  };
};

// ---------------------------------------------------------------------------
// The team cache, over plain PostgREST
//
// Also fetch rather than supabase-js, for the same reason as everything above.
// A score one teammate paid for should not be paid for again, and that has to
// work without anyone having a dashboard open.
// ---------------------------------------------------------------------------

const restHeaders = (anonKey, token) => ({
  "content-type": "application/json",
  apikey: anonKey,
  Authorization: `Bearer ${token}`,
});

export const readRemoteScore = async ({ url, anonKey, token, teamId, adId }) => {
  if (!teamId || !token) return null;
  try {
    const res = await fetch(
      `${url}/rest/v1/ad_scores?team_id=eq.${teamId}&archive_id=eq.${encodeURIComponent(adId)}&rubric_version=eq.${RUBRIC_VERSION}&select=*`,
      { headers: restHeaders(anonKey, token) },
    );
    if (!res.ok) return null;
    const rows = await res.json();
    const row = rows && rows[0];
    if (!row) return null;
    return {
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
    };
  } catch (err) {
    return null;
  }
};

export const writeRemoteScore = async ({ url, anonKey, token, teamId, score }) => {
  if (!teamId || !token) return false;
  try {
    const res = await fetch(`${url}/rest/v1/ad_scores?on_conflict=team_id,archive_id,rubric_version`, {
      method: "POST",
      headers: {
        ...restHeaders(anonKey, token),
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        team_id: teamId,
        archive_id: score.adId,
        rubric_version: score.rubricVersion,
        model: score.model,
        axes: score.axes,
        frames: score.frames,
        frame_kind: score.frameKind,
        usage: score.usage,
        problems: score.problems,
      }),
    });
    return res.ok;
  } catch (err) {
    return false;
  }
};

export { RUBRIC_VERSION };
