/**
 * Calling Claude from the extension, without the key being in the extension.
 *
 * Every call goes through the Edge Function in supabase/functions/claude, which
 * holds the key, checks the caller is signed in, checks team membership when a
 * team is named, and meters them. Nothing here can reach Anthropic directly and
 * that is the point: this file ships to every user who installs the extension.
 */
import { getClient, getSession } from "./client.js";
import { loadConfig } from "./config.js";

/**
 * The model these features are designed around.
 *
 * Sonnet 5, chosen for cost. Script and shot-list generation is the more
 * demanding of the two callers - scoring is a bounded judgement against an
 * anchored rubric, writing is not - so if one of them should go back to Opus 5
 * it is this one.
 */
export const MODEL = "claude-sonnet-5";

/**
 * One call. Returns { ok, content } or { ok: false, error }.
 *
 * Errors are returned rather than thrown because every caller is a UI action
 * that needs to say something useful rather than break a render.
 */
export const ask = async ({
  messages,
  system,
  maxTokens = 2048,
  model = MODEL,
  teamId = null,
  thinking = { type: "adaptive" },
  outputConfig = null,
}) => {
  const { url, anonKey } = await loadConfig();
  if (!url) return { ok: false, error: "Supabase is not configured yet." };

  // Signed out, the publishable key is the credential. The Edge Function only
  // honours it when its own ALLOW_ANON secret is set, so nothing here can widen
  // access from the client.
  const session = await getSession();
  const bearer = (session && session.access_token) || anonKey;
  if (!bearer) return { ok: false, error: "This project is not configured." };

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
        system,
        messages,
        max_tokens: maxTokens,
        thinking,
        ...(outputConfig ? { output_config: outputConfig } : {}),
        teamId,
      }),
    });
  } catch (err) {
    return { ok: false, error: "Could not reach the proxy." };
  }

  const text = await res.text();
  if (!res.ok) {
    // A bare "Request failed (404)" is the least useful thing this could say.
    // A 404 here has exactly one cause and exactly one fix, and the same is
    // true of a 401, so both name the command rather than the status.
    let message;
    if (res.status === 404)
      message =
        "The AI function is not deployed. Run: supabase functions deploy claude";
    else if (res.status === 401 || res.status === 403)
      message =
        "The AI function refused the request. Either sign in under Settings, or allow signed-out use: supabase secrets set ALLOW_ANON=true";
    else if (res.status === 429) message = "The daily AI limit has been reached.";
    else {
      message = `Request failed (${res.status})`;
      try {
        const parsed = JSON.parse(text);
        if (parsed && parsed.error) message = parsed.error;
      } catch (err) {
        /* not JSON; the status is all we have */
      }
    }
    return { ok: false, error: message, status: res.status };
  }

  try {
    return { ok: true, ...JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: "The proxy returned something that was not JSON." };
  }
};

/**
 * The proxy's own reachability, reported the same way the sync status is: as
 * separate facts, because "not deployed" and "no key set" need different fixes
 * and a single red light tells you neither.
 */
export const checkProxy = async () => {
  const { url } = await loadConfig();
  const out = { configured: !!url, deployed: false, keySet: false, signedIn: false };
  if (!url) return out;

  out.signedIn = !!(await getSession());

  try {
    // An empty POST: a deployed function answers 400 or 401, a missing one 404.
    const res = await fetch(`${url}/functions/v1/claude`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    out.deployed = res.status !== 404;
    if (!out.deployed) {
      out.error = "Deploy it with: supabase functions deploy claude";
      return out;
    }
    // 500 is the one status the function returns for a missing key.
    if (res.status === 500) {
      const body = await res.json().catch(() => ({}));
      if (/not configured/i.test(body.error || "")) {
        out.error = "Set the key: supabase secrets set ANTHROPIC_API_KEY=...";
        return out;
      }
    }
    out.keySet = true;
  } catch (err) {
    out.error = "Could not reach the proxy.";
  }

  return out;
};

/** Ignore the client here; it exists so callers can await readiness in one go. */
export const ready = async () => !!(await getClient()) && !!(await getSession());
