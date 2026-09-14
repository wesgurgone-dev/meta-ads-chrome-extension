/**
 * Turning a canvas into a shot list and a script.
 *
 * Runs in the dashboard page for the same reasons sync and scoring do: the
 * service worker is unbundled, so it cannot import supabase-js, and it dies
 * after about thirty seconds idle, which is no place to await a reasoning
 * model. The Anthropic key is never here; the call goes through the Edge
 * Function that holds it.
 *
 * The result is stored as a run, not as a field on the canvas. The graph is the
 * only mutable state; a generation is append-only with provenance. That is not
 * bookkeeping for its own sake - the output is genuinely not regenerable. The
 * model is nondeterministic, referenced ads can be deleted, and a re-run a
 * month later answers from thinner inputs. Re-running is a new draft, and a
 * shot list that went to a shoot has to still be there afterwards.
 */
import { ask, MODEL } from "../supabase/ai.js";
import {
  PROMPT_VERSION,
  RUN_SCHEMA,
  SYSTEM,
  buildUserMessage,
  graphInputs,
  inputDigest,
  outputNode,
} from "./model.js";

const send = (msg) =>
  new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => resolve(res || { ok: false }));
    } catch (err) {
      resolve({ ok: false, error: String(err && err.message) });
    }
  });

/** What the run saw, kept small: the audit trail, not a second copy of the ad. */
const slimInputs = (inputs) =>
  inputs.map((i) => ({
    nodeId: i.nodeId,
    kind: i.kind,
    adId: i.adId,
    note: i.note,
    inLibrary: i.inLibrary,
    pageName: (i.snapshot && i.snapshot.pageName) || null,
  }));

export const generate = async (canvas, ads, { teamId = null, model = MODEL } = {}) => {
  const inputs = graphInputs(canvas, ads);
  if (!inputs.length)
    return {
      ok: false,
      error: "Wire at least one reference into the output node first.",
    };

  const out = outputNode(canvas);
  const res = await ask({
    model,
    system: SYSTEM,
    messages: [
      { role: "user", content: [{ type: "text", text: buildUserMessage(inputs, out && out.note) }] },
    ],
    // Thinking is on by default and counts against this ceiling, so a number
    // sized for the JSON alone truncates mid-object.
    maxTokens: 4000,
    outputConfig: { effort: "medium", format: { type: "json_schema", schema: RUN_SCHEMA } },
    teamId,
  });
  if (!res.ok) return res;
  if (res.stop_reason === "refusal")
    return { ok: false, error: "The model declined to write this one." };

  const text = (res.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: "The model did not return the expected JSON." };
  }

  const run = {
    canvasId: canvas.id,
    spaceId: canvas.spaceId,
    outputNodeId: out ? out.id : null,
    status: "done",
    model,
    promptVersion: PROMPT_VERSION,
    // The fingerprint of the graph as it was. When it stops matching, the UI
    // says the brief has moved on rather than quietly showing a stale answer.
    inputDigest: inputDigest(canvas),
    inputs: slimInputs(inputs),
    concept: parsed.concept || "",
    shotList: parsed.shot_list || [],
    script: parsed.script || [],
    notes: parsed.notes || "",
    usage: res.usage || null,
    createdAt: Date.now(),
  };

  const saved = await send({ type: "CANVAS_OP", op: "save_run", run });
  return { ok: true, run: (saved && saved.run) || run };
};

/** A plain-text export, because a shot list is something people take to a shoot. */
export const runToText = (run, canvasName) => {
  const lines = [
    canvasName || "Canvas",
    new Date(run.createdAt).toLocaleString(),
    "",
    run.concept ? `CONCEPT\n${run.concept}\n` : "",
    "SHOT LIST",
    ...(run.shotList || []).map(
      (s) => `${s.n}. (${s.seconds}s) ${s.shot}\n   why: ${s.why}`,
    ),
    "",
    "SCRIPT",
    ...(run.script || []).map(
      (s) => `${s.at}  ${s.line}${s.on_screen ? `\n      on screen: ${s.on_screen}` : ""}`,
    ),
    "",
    run.notes ? `NOTES\n${run.notes}` : "",
    "",
    `References: ${(run.inputs || [])
      .map((i) => `${i.pageName || i.adId || "note"}${i.note ? ` (${i.note})` : ""}`)
      .join(", ")}`,
    `${run.model} · ${run.promptVersion}`,
  ];
  return lines.filter((l) => l !== "").join("\n");
};
