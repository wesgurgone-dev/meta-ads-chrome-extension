/**
 * Anthropic proxy.
 *
 * The extension is client code: anything it ships can be read by anyone who
 * installs it, so an Anthropic key cannot go there. This function holds the key
 * server-side, checks that the caller is a signed-in member of the team they
 * claim, meters them, and forwards the call.
 *
 * Deploy:
 *   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
 *   supabase functions deploy claude
 *
 * The key is set as a secret and read from the environment. It is never
 * returned, logged, or echoed in an error.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/** Ceilings, so one runaway loop cannot spend a month's budget in an afternoon. */
const LIMITS = {
  perDay: 400,
  maxOutputTokens: 4096,
  maxImages: 16,
};

/** Only the models this feature is designed around. */
const ALLOWED_MODELS = new Set([
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
]);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // The caller is a chrome-extension:// origin, which is opaque, so the
      // check that matters is the JWT below, not the origin.
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "POST, OPTIONS",
    },
  });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json({}, 204);
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "The proxy is not configured." }, 500);

  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer "))
    return json({ error: "Sign in first." }, 401);

  // The anon key plus the caller's JWT: every query below runs as the caller,
  // so the row policies apply and this function cannot be tricked into reading
  // another team's rows.
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: userData, error: userError } = await supabase.auth.getUser();
  const user = userData?.user;
  if (userError || !user) return json({ error: "Sign in first." }, 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }

  const { model, messages, system, max_tokens, thinking, teamId } = body as {
    model?: string;
    messages?: unknown[];
    system?: string;
    max_tokens?: number;
    thinking?: unknown;
    teamId?: string;
  };

  if (!model || !ALLOWED_MODELS.has(model))
    return json({ error: `model must be one of ${[...ALLOWED_MODELS].join(", ")}` }, 400);
  if (!Array.isArray(messages) || messages.length === 0)
    return json({ error: "messages is required" }, 400);

  // An image-heavy request is the expensive one, so it is capped here rather
  // than trusted from the client.
  const images = JSON.stringify(messages).match(/"type"\s*:\s*"image"/g)?.length ?? 0;
  if (images > LIMITS.maxImages)
    return json({ error: `at most ${LIMITS.maxImages} images per call` }, 400);

  // A caller naming a team must actually be in it. Membership is checked by
  // reading through the caller's own JWT, so RLS does the work.
  if (teamId) {
    const { data: member } = await supabase
      .from("team_members")
      .select("team_id")
      .eq("team_id", teamId)
      .maybeSingle();
    if (!member) return json({ error: "Not a member of that team." }, 403);
  }

  // Metering. A failure to record is not a reason to refuse the call, but a
  // caller already over the ceiling is.
  const { data: used } = await supabase.rpc("ai_usage_today");
  if (typeof used === "number" && used >= LIMITS.perDay)
    return json({ error: `Daily limit of ${LIMITS.perDay} calls reached.` }, 429);

  const upstream = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: Math.min(Number(max_tokens) || 2048, LIMITS.maxOutputTokens),
      messages,
      ...(system ? { system } : {}),
      ...(thinking ? { thinking } : {}),
    }),
  });

  const text = await upstream.text();
  if (!upstream.ok) {
    // Upstream errors can echo request detail; return the status and a generic
    // message rather than forwarding a body that might carry anything.
    console.error("anthropic error", upstream.status, text.slice(0, 400));
    return json({ error: `Upstream error ${upstream.status}` }, 502);
  }

  await supabase.rpc("ai_usage_record", { tokens: text.length });

  return new Response(text, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  });
});
