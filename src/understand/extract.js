/**
 * The one vision pass, run once per ad.
 *
 * Runs in the service worker like scoring does, so it imports nothing but its
 * own prompt and schema and talks over plain fetch.
 *
 * This is the expensive call in the whole product and it is deliberately the
 * only one that looks at pixels. Everything downstream - the score, the
 * discovery terms, the script generation - reads the record it produces. That
 * is what makes a rubric edit cheap to re-run, and what lets an ad saved six
 * months ago still be useful after its CDN links have expired.
 */
import { EXTRACT_SYSTEM, EXTRACT_TASK, EXTRACT_VERSION } from "./prompt.js";
import { UNDERSTANDING_SCHEMA, UNDERSTANDING_VERSION, validateUnderstanding } from "./schema.js";

/**
 * Opus 5, not Sonnet, and this is the one call where that is worth arguing for.
 *
 * It is paid once per ad and everything else in the product is downstream of
 * how well it sees. A cheaper model here does not make one answer slightly
 * worse; it makes every score and every discovery sweep worse, permanently,
 * because nothing re-watches the video to correct it.
 */
export const EXTRACT_MODEL = "claude-opus-5";

export const buildExtractMessages = (facts, images) => {
  const content = [{ type: "text", text: facts }];
  for (const img of images) {
    content.push({ type: "text", text: img.label });
    content.push({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.data },
    });
  }
  content.push({ type: "text", text: EXTRACT_TASK });
  return [{ role: "user", content }];
};

/**
 * Returns { ok: true, understanding } or { ok: false, code, detail }.
 * The failure codes are the scorer's, so the queue can treat both the same way.
 */
export const extractUnderstanding = async (
  ad,
  { facts, images, url, anonKey, token, teamId = null, model = EXTRACT_MODEL, FAILURE },
) => {
  const startedAt = Date.now();
  if (!images.length) return { ok: false, code: FAILURE.NOTHING_TO_SEE };
  if (!url) return { ok: false, code: FAILURE.SIGNED_OUT };
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
        system: [{ type: "text", text: EXTRACT_SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: buildExtractMessages(facts, images),
        max_tokens: 4000,
        thinking: { type: "adaptive" },
        // Medium, not low. This is the call whose quality everything else
        // inherits, and it is paid once - the one place in this product where
        // spending more is straightforwardly correct.
        output_config: {
          effort: "medium",
          format: { type: "json_schema", schema: UNDERSTANDING_SCHEMA },
        },
        teamId,
      }),
    });
  } catch (err) {
    return { ok: false, code: FAILURE.OFFLINE, detail: String(err && err.message) };
  }

  if (res.status === 404) return { ok: false, code: FAILURE.NOT_DEPLOYED };
  if (res.status === 401 || res.status === 403) return { ok: false, code: FAILURE.SIGNED_OUT };
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
    return { ok: false, code: FAILURE.BAD_REPLY, detail: "The model declined to watch this ad." };

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

  const check = validateUnderstanding(parsed);
  return {
    ok: true,
    understanding: {
      adId: ad.id,
      v: UNDERSTANDING_VERSION,
      extractVersion: EXTRACT_VERSION,
      model,
      ...parsed,
      frames: images.length,
      usage: reply.usage || null,
      cached: (reply.usage && reply.usage.cache_read_input_tokens) || 0,
      ms: Date.now() - startedAt,
      problems: check.ok ? null : check.problems,
      createdAt: Date.now(),
    },
  };
};
