/**
 * What one ad actually is, extracted once from its frames and its copy.
 *
 * This is the record every other feature reads instead of re-deriving meaning
 * from the caption. The caption is usually the worst available description of
 * an ad: "Hydration that works" tells you nothing about the product, the niche
 * or who it is for, and a term extractor pointed at it can only ever return
 * "hydration" and "works". Everything that matters is in the video.
 *
 * So the video is watched once, by a model good enough to be worth trusting,
 * and the result is kept. Scoring, discovery and script generation then run as
 * cheap text calls over this record rather than paying for vision again - which
 * also means a rubric edit or a better discovery prompt costs almost nothing to
 * re-run, and works on ads whose CDN links died months ago.
 */

export const UNDERSTANDING_VERSION = "understanding_v1";

const list = (maxItems, maxLength) => ({
  type: "array",
  maxItems,
  items: { type: "string", maxLength },
});

export const UNDERSTANDING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["product", "audience", "claims", "format", "hook", "beats", "production", "discovery", "summary"],
  properties: {
    product: {
      type: "object",
      additionalProperties: false,
      required: ["what", "category", "niche", "brand_role"],
      properties: {
        // Literally what is being sold, as a person would say it out loud.
        what: { type: "string", maxLength: 200 },
        // Broad enough that competitors share it: "electrolyte drink mix".
        category: { type: "string", maxLength: 80 },
        // Narrow enough to be useful: "sugar-free hydration for endurance
        // athletes". This is the field discovery leans on hardest.
        niche: { type: "string", maxLength: 160 },
        brand_role: {
          type: "string",
          enum: ["the advertiser sells it", "a reseller or marketplace", "an affiliate or review", "unclear"],
        },
      },
    },
    audience: {
      type: "object",
      additionalProperties: false,
      required: ["who", "problem"],
      properties: {
        who: { type: "string", maxLength: 200 },
        problem: { type: "string", maxLength: 200 },
      },
    },
    claims: list(8, 200),
    format: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "style", "has_speech", "on_screen_text"],
      properties: {
        kind: {
          type: "string",
          enum: ["talking head", "demo", "testimonial", "skit", "comparison", "unboxing", "montage", "static", "other"],
        },
        style: { type: "string", maxLength: 120 },
        has_speech: { type: "boolean" },
        on_screen_text: list(10, 120),
      },
    },
    hook: {
      type: "object",
      additionalProperties: false,
      required: ["what_happens", "device"],
      properties: {
        what_happens: { type: "string", maxLength: 300 },
        device: { type: "string", maxLength: 120 },
      },
    },
    beats: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["at", "what", "purpose"],
        properties: {
          at: { type: "string", maxLength: 16 },
          what: { type: "string", maxLength: 300 },
          purpose: { type: "string", maxLength: 160 },
        },
      },
    },
    // Observations, not judgements. The scorer decides whether framing that is
    // "handheld, subject centred, window light from camera left" is good; this
    // pass only has to see it accurately.
    production: {
      type: "object",
      additionalProperties: false,
      required: ["lighting", "framing", "stability", "text_legibility", "edit", "aspect"],
      properties: {
        lighting: { type: "string", maxLength: 200 },
        framing: { type: "string", maxLength: 200 },
        stability: { type: "string", maxLength: 160 },
        text_legibility: { type: "string", maxLength: 160 },
        edit: { type: "string", maxLength: 200 },
        aspect: { type: "string", maxLength: 60 },
      },
    },
    discovery: {
      type: "object",
      additionalProperties: false,
      required: ["search_terms", "adjacent_products", "competitor_guesses"],
      properties: {
        // What a *different* advertiser in this niche would run ads about.
        // Not this brand's words - the category's words.
        search_terms: list(10, 60),
        adjacent_products: list(8, 80),
        competitor_guesses: list(8, 80),
      },
    },
    // Whether the frames were enough to answer honestly, and what was guessed.
    limits: { type: "string", maxLength: 300 },
    summary: { type: "string", maxLength: 600 },
  },
};

/**
 * The record as prose.
 *
 * Kept as a rendering of the structured object rather than as a second stored
 * field, so the two can never drift. Scoring and script generation read this;
 * discovery reads the structured fields directly, because it needs terms as
 * data rather than as a paragraph.
 */
export const toMarkdown = (u, ad = {}) => {
  if (!u) return "";
  const lines = [
    `# ${ad.pageName || "Unknown advertiser"}`,
    "",
    u.summary,
    "",
    "## Product",
    `- **What it is:** ${u.product.what}`,
    `- **Category:** ${u.product.category}`,
    `- **Niche:** ${u.product.niche}`,
    `- **Who is selling it:** ${u.product.brand_role}`,
    "",
    "## Audience",
    `- **Who it is for:** ${u.audience.who}`,
    `- **Problem it addresses:** ${u.audience.problem}`,
    "",
    "## Claims",
    ...(u.claims || []).map((c) => `- ${c}`),
    "",
    "## Format",
    `- **Kind:** ${u.format.kind}`,
    `- **Style:** ${u.format.style}`,
    `- **Speech:** ${u.format.has_speech ? "yes" : "none audible from the frames"}`,
    ...((u.format.on_screen_text || []).length
      ? [`- **On screen:** ${u.format.on_screen_text.join(" / ")}`]
      : []),
    "",
    "## Hook",
    `- **What happens:** ${u.hook.what_happens}`,
    `- **Device:** ${u.hook.device}`,
    "",
    "## Beats",
    ...(u.beats || []).map((b) => `- **${b.at}** ${b.what} _(${b.purpose})_`),
    "",
    "## Production",
    `- **Lighting:** ${u.production.lighting}`,
    `- **Framing:** ${u.production.framing}`,
    `- **Stability:** ${u.production.stability}`,
    `- **Text legibility:** ${u.production.text_legibility}`,
    `- **Edit:** ${u.production.edit}`,
    `- **Aspect:** ${u.production.aspect}`,
    "",
    "## Discovery",
    `- **Category search terms:** ${(u.discovery.search_terms || []).join(", ")}`,
    `- **Adjacent products:** ${(u.discovery.adjacent_products || []).join(", ")}`,
    `- **Likely competitors:** ${(u.discovery.competitor_guesses || []).join(", ")}`,
    ...(u.limits ? ["", "## Limits", u.limits] : []),
  ];
  return lines.join("\n");
};

/** Cheap sanity check. A record that fails this is stored anyway, flagged. */
export const validateUnderstanding = (u) => {
  const problems = [];
  if (!u || typeof u !== "object") return { ok: false, problems: ["not an object"] };
  if (!u.product || !u.product.what) problems.push("no product");
  if (!u.product || !u.product.niche) problems.push("no niche");
  if (!Array.isArray(u.beats) || !u.beats.length) problems.push("no beats");
  const terms = (u.discovery && u.discovery.search_terms) || [];
  if (!terms.length) problems.push("no search terms");
  return { ok: problems.length === 0, problems };
};
