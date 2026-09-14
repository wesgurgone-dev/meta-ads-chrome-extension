/**
 * The structured-output schema, and the check that the model honoured it.
 *
 * Field order matters here in a way it usually does not: the model generates
 * left to right, so putting evidence and frame before the band, and the band
 * before the score, is what makes the number follow from a citation instead of
 * from a vibe. Reordering these properties weakens the scores without changing
 * anything that looks like behaviour.
 */
import { RUBRIC_VERSION } from "./rubric.js";

export const AXES = ["hook", "utility", "succinctness", "production"];

export const AXIS_LABELS = {
  hook: "Hook",
  utility: "Utility",
  succinctness: "Succinctness",
  production: "Production",
};

export const BANDS = {
  weak: [1, 3],
  competent: [4, 6],
  strong: [7, 8],
  exceptional: [9, 10],
};

const axisSchema = {
  type: "object",
  additionalProperties: false,
  required: ["evidence", "frame_index", "band", "score"],
  properties: {
    evidence: { type: "string", maxLength: 240 },
    frame_index: { type: "integer", minimum: 0, maximum: 15 },
    band: { type: "string", enum: Object.keys(BANDS) },
    score: { type: "integer", minimum: 1, maximum: 10 },
  },
};

export const SCORE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rubric_version", "axes"],
  properties: {
    rubric_version: { type: "string", enum: [RUBRIC_VERSION] },
    axes: {
      type: "object",
      additionalProperties: false,
      required: AXES,
      properties: Object.fromEntries(AXES.map((a) => [a, axisSchema])),
    },
  },
};

/**
 * Validate a parsed result. A band that does not match its score is a rubric
 * bug worth surfacing, not a reason to retry: retrying costs money and hides
 * the fact that the anchors stopped working.
 */
export const validateScore = (parsed) => {
  const problems = [];
  if (!parsed || typeof parsed !== "object") return { ok: false, problems: ["not an object"] };
  if (parsed.rubric_version !== RUBRIC_VERSION)
    problems.push(`rubric_version ${parsed.rubric_version} is not ${RUBRIC_VERSION}`);
  const axes = parsed.axes || {};
  for (const axis of AXES) {
    const a = axes[axis];
    if (!a) {
      problems.push(`${axis} missing`);
      continue;
    }
    const range = BANDS[a.band];
    if (!range) {
      problems.push(`${axis} band ${a.band} unknown`);
      continue;
    }
    if (!Number.isInteger(a.score) || a.score < range[0] || a.score > range[1])
      problems.push(`${axis} score ${a.score} outside band ${a.band}`);
    if (!a.evidence || !String(a.evidence).trim())
      problems.push(`${axis} has no evidence`);
  }
  return { ok: problems.length === 0, problems };
};

/**
 * The overall number is computed here, not stored, so the weights can be
 * retuned without re-scoring a single ad.
 */
export const WEIGHTS = { hook: 0.35, utility: 0.3, succinctness: 0.15, production: 0.2 };

export const overallScore = (axes) => {
  if (!axes) return null;
  let total = 0;
  let weight = 0;
  for (const axis of AXES) {
    const a = axes[axis];
    if (!a || typeof a.score !== "number") continue;
    total += a.score * WEIGHTS[axis];
    weight += WEIGHTS[axis];
  }
  return weight ? Number((total / weight).toFixed(1)) : null;
};
