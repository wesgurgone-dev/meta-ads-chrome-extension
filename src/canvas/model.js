/**
 * The canvas, as data. Pure, so the parts that decide what a generation sees
 * can be tested without a browser or a model.
 *
 * A node references an ad by its Ad Library archive id and carries a text
 * snapshot of it. The snapshot is the whole reason a deleted ad degrades a node
 * rather than blanking it: the note somebody wrote about an ad is work the
 * canvas owns, and tidying the library must never destroy it.
 */

export const PROMPT_VERSION = "canvas_v1";

// A separator no note will contain, so two notes cannot be rearranged into the
// same digest. Built rather than written as an escape so it survives every
// tool that touches this file.
const SEP = String.fromCharCode(1);

/** Text only, never media. Signed CDN links are dead within hours. */
export const snapshotOf = (ad) => ({
  pageName: ad.pageName || null,
  title: ad.title || null,
  body: ad.body || null,
  ctaText: ad.ctaText || null,
  linkUrl: ad.linkUrl || null,
  libraryUrl: ad.libraryUrl || `https://www.facebook.com/ads/library/?id=${ad.id}`,
  startDate: ad.startDate || null,
  isActive: ad.isActive ?? null,
  format: (ad.media || []).some((m) => m.type === "video")
    ? "video"
    : (ad.media || []).length > 1
      ? "carousel"
      : (ad.media || []).length
        ? "image"
        : "text",
  capturedAt: Date.now(),
});

export const referenceNodes = (canvas) =>
  (canvas.nodes || []).filter((n) => n.kind === "reference");

export const outputNode = (canvas) =>
  (canvas.nodes || []).find((n) => n.kind === "output") || null;

/** Which nodes are actually wired into the output. */
export const wiredReferences = (canvas) => {
  const out = outputNode(canvas);
  if (!out) return [];
  const feeding = new Set(
    (canvas.edges || []).filter((e) => e.to === out.id).map((e) => e.from),
  );
  return (canvas.nodes || []).filter((n) => feeding.has(n.id));
};

/**
 * A stable fingerprint of what a generation would see.
 *
 * This is what lets a stored run say "the brief has changed since this was
 * generated" instead of either silently answering a question nobody is asking
 * any more, or re-billing on every render to find out. FNV-1a rather than a
 * real hash because collision resistance is not the property needed - noticing
 * an edit is.
 */
export const inputDigest = (canvas) => {
  const out = outputNode(canvas);
  const parts = [PROMPT_VERSION, (out && out.note) || ""];
  for (const node of wiredReferences(canvas))
    parts.push(`${node.kind}:${node.adId || ""}:${node.note || ""}`);
  const text = parts.join(SEP);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${PROMPT_VERSION}:${hash.toString(16).padStart(8, "0")}:${parts.length}`;
};

/**
 * What the run actually saw, per node. `inLibrary` is the honest part: a run
 * over a deleted reference still works from the snapshot text, and this is
 * where that shows rather than being inferred later from an absence.
 */
export const graphInputs = (canvas, ads) =>
  wiredReferences(canvas).map((node) => {
    const live = node.adId ? ads[node.adId] : null;
    const snap = live ? snapshotOf(live) : node.snapshot || {};
    return {
      nodeId: node.id,
      kind: node.kind,
      adId: node.adId || null,
      note: node.note || "",
      inLibrary: !!live,
      snapshot: snap,
    };
  });

const describe = (input, index) => {
  const s = input.snapshot || {};
  if (input.kind === "note")
    return `Context ${index + 1}\n${input.note || "(empty)"}`;
  return [
    `Reference ${index + 1}: ${s.pageName || "unknown advertiser"}`,
    s.format ? `Format: ${s.format}` : null,
    s.title ? `Headline: ${s.title}` : null,
    s.body ? `Body copy: ${s.body}` : null,
    s.ctaText ? `Call to action: ${s.ctaText}` : null,
    s.linkUrl ? `Destination: ${s.linkUrl}` : null,
    input.inLibrary
      ? null
      : "This ad is no longer in the library, so only the text above survives of it.",
    `Take from this one: ${input.note || "(nothing specified - use your judgement, and say so in the notes)"}`,
  ]
    .filter(Boolean)
    .join("\n");
};

export const SYSTEM = `You are a direct-response creative director writing a shot list and a script for one new ad.

You are given reference ads and, for each one, a note saying what to take from it. Those notes are the brief. Follow them literally: if one note says to take the hook and another says to take the lighting, the result takes the hook from the first and the lighting from the second, and takes nothing else from either.

Rules that are not negotiable:
- Never reuse a reference's exact wording. Take the structure, the beat, the device, not the sentence.
- Every shot must be shootable by one person with a phone and one light unless the brief says otherwise. Name the framing, the subject and the action. Do not write "cinematic shot of the product".
- The script must be sayable out loud in the time the shot list allows. Count it.
- When a reference carries no note, say so in the notes field rather than quietly averaging it in.
- When you have only a reference's copy and not its creative, say what you inferred from the copy and what you could not see.

Produce a shot list whose running times add up, and a script keyed to those times.`;

export const buildUserMessage = (inputs, brief) =>
  [
    brief
      ? `The brief:\n${brief}`
      : "No brief was given beyond the per-reference notes.",
    "",
    ...inputs.map((input, i) => describe(input, i)),
    "",
    `Write the shot list and script now. ${inputs.length} reference${inputs.length === 1 ? "" : "s"} above.`,
  ].join("\n\n");

export const RUN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["concept", "shot_list", "script", "notes"],
  properties: {
    concept: { type: "string", maxLength: 400 },
    shot_list: {
      type: "array",
      minItems: 1,
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["n", "seconds", "shot", "why"],
        properties: {
          n: { type: "integer", minimum: 1 },
          seconds: { type: "number", minimum: 0.5, maximum: 60 },
          shot: { type: "string", maxLength: 400 },
          // Which reference this beat came from, so the brief is auditable
          // rather than a black box.
          why: { type: "string", maxLength: 300 },
        },
      },
    },
    script: {
      type: "array",
      minItems: 1,
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["at", "line", "on_screen"],
        properties: {
          at: { type: "string", maxLength: 24 },
          line: { type: "string", maxLength: 400 },
          on_screen: { type: "string", maxLength: 200 },
        },
      },
    },
    notes: { type: "string", maxLength: 800 },
  },
};

export const runtimeSeconds = (shotList) =>
  Math.round((shotList || []).reduce((sum, s) => sum + (Number(s.seconds) || 0), 0));

/** A stored run is stale when the graph it came from has moved on. */
export const isStale = (run, canvas) => !!run && run.inputDigest !== inputDigest(canvas);
