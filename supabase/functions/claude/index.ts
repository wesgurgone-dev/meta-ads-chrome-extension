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
 * Testing without sign-in (see ALLOW_ANON below before using it):
 *   supabase secrets set ALLOW_ANON=true
 *   supabase functions deploy claude --no-verify-jwt
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

  const { data: userData } = await supabase.auth.getUser();
  const user = userData?.user ?? null;

  // Signed-out access, for a testing phase.
  //
  // Off unless the project owner sets ALLOW_ANON=true as a secret, so the
  // extension cannot turn it on: the switch lives on the server, with whoever
  // pays the Anthropic bill. While it is on, anyone holding the publishable key
  // - which ships in the extension and is readable by anyone who installs it -
  // can spend that bill. There is also no per-caller meter without a user, so
  // `public.ai_usage` records nothing and the only ceiling is the one set in
  // the Anthropic console. Turn it off before this is in anyone else's hands:
  //   supabase secrets unset ALLOW_ANON
  const allowAnon = (Deno.env.get("ALLOW_ANON") || "").toLowerCase() === "true";
  if (!user && !allowAnon)
    return json({ error: "Sign in first." }, 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }

  const { model, messages, system, max_tokens, thinking, output_config, fast, teamId } =
    body as {
      model?: string;
      // A string, or content blocks - blocks are what carries cache_control, and
      // a frozen cached rubric is the whole reason the scoring prompt is stable.
      messages?: unknown[];
      system?: string | unknown[];
      max_tokens?: number;
      thinking?: unknown;
      output_config?: unknown;
      fast?: boolean;
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
  // reading through the caller's own JWT, so RLS does the work. Signed out
  // there is no membership to check and no team rows to reach, so a teamId is
  // simply ignored rather than trusted.
  if (teamId && user) {
    const { data: member } = await supabase
      .from("team_members")
      .select("team_id")
      .eq("team_id", teamId)
      .maybeSingle();
    if (!member) return json({ error: "Not a member of that team." }, 403);
  }

  // Metering. A failure to record is not a reason to refuse the call, but a
  // caller already over the ceiling is. The meter is keyed on auth.uid(), so
  // there is nothing to count for an anonymous caller - see ALLOW_ANON above.
  if (user) {
    const { data: used } = await supabase.rpc("ai_usage_today");
    if (typeof used === "number" && used >= LIMITS.perDay)
      return json({ error: `Daily limit of ${LIMITS.perDay} calls reached.` }, 429);
  }

  // Fast mode is the same model at up to 2.5x the output rate, at roughly
  // double the price. It needs the beta endpoint, the beta header and a
  // top-level speed parameter - all three, or it is silently ignored.
  const wantFast = fast === true && model === "claude-opus-5";

  const upstream = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      ...(wantFast ? { "anthropic-beta": "fast-mode-2026-02-01" } : {}),
    },
    body: JSON.stringify({
      model,
      max_tokens: Math.min(Number(max_tokens) || 2048, LIMITS.maxOutputTokens),
      messages,
      ...(system ? { system } : {}),
      ...(thinking ? { thinking } : {}),
      // Structured output and effort. Forwarded rather than constructed here so
      // the rubric and its schema stay in one place, versioned together.
      ...(output_config ? { output_config } : {}),
      ...(wantFast ? { speed: "fast" } : {}),
    }),
  });

  const text = await upstream.text();
  if (!upstream.ok) {
    // Upstream errors can echo request detail; return the status and a generic
    // message rather than forwarding a body that might carry anything.
    console.error("anthropic error", upstream.status, text.slice(0, 400));
    return json({ error: `Upstream error ${upstream.status}` }, 502);
  }

  if (user) await supabase.rpc("ai_usage_record", { tokens: text.length });

  return new Response(text, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  });
});
