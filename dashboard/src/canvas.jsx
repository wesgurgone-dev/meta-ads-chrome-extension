/**
 * The node canvas: reference ads wired into an output that writes a shot list.
 *
 * Hand-rolled rather than React Flow, and the reason is measured, not stylistic.
 * React Flow costs about 177KB minified into this bundle - it does not
 * tree-shake, so dropping the minimap and controls saves 91 bytes - against a
 * budget with roughly 30KB left. The whole viewport, drag, edge-drawing and
 * hit-testing layer below is a few KB, and the graph this feature needs is a
 * star: N references into one output, one edge type, one direction, no nesting.
 * If that ever stops being true - many-to-many wiring, groups, undo across
 * graph operations - the cost curve crosses and this should be revisited.
 *
 * Four mechanics below are the ones that are easy to get subtly wrong:
 *
 *   - The wheel listener is attached with { passive: false }. React registers
 *     wheel passively at the root, so preventDefault() from an onWheel prop is
 *     ignored and the page scrolls underneath the canvas.
 *   - Zoom is about the pointer, which needs the second line as well as the
 *     scale: without it the graph slides away from the cursor.
 *   - Drag offsets are stored in world space, or a node snaps its corner to the
 *     cursor at any zoom but 1.
 *   - Dropping an edge uses elementFromPoint rather than rectangle maths, so the
 *     browser hit-tests through the transform and it is correct at every zoom.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "open-glass-ui";
import { Surface } from "../../src/surface.jsx";
import { downloadBlob, send, thumbFor } from "./lib.js";
import {
  isStale,
  outputNode,
  runtimeSeconds,
  snapshotOf,
} from "../../src/canvas/model.js";
import { generate, runToText } from "../../src/canvas/generate.js";

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 1.8;
const NODE_WIDTH = 260;

const uid = () => crypto.randomUUID();

/** The Weavy / n8n curve: horizontal tangents, so edges read left to right. */
const edgePath = (a, b) => {
  const d = Math.max(40, Math.abs(b.x - a.x) * 0.5);
  return `M ${a.x} ${a.y} C ${a.x + d} ${a.y}, ${b.x - d} ${b.y}, ${b.x} ${b.y}`;
};

const portOut = (node) => ({ x: node.x + NODE_WIDTH, y: node.y + 46 });
const portIn = (node) => ({ x: node.x, y: node.y + 46 });

const AdPicker = ({ ads, onPick, onClose }) => {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const needle = q.toLowerCase();
    return ads
      .filter(
        (a) =>
          !needle ||
          (a.pageName || "").toLowerCase().includes(needle) ||
          (a.body || "").toLowerCase().includes(needle),
      )
      .slice(0, 60);
  }, [ads, q]);

  return (
    <div className="modal">
      <div className="modal-backdrop" onClick={onClose} />
      <Surface className="modal-card wf-picker" material="frosted" radius={18}>
        <button className="modal-close" type="button" onClick={onClose}>
          &#10005;
        </button>
        <h2>Add a reference</h2>
        <input
          type="search"
          placeholder="Search your saved ads..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search saved ads"
        />
        <div className="wf-picker-grid">
          {shown.map((ad) => (
            <button key={ad.id} type="button" className="wf-picker-item" onClick={() => onPick(ad)}>
              {thumbFor(ad) ? <img src={thumbFor(ad)} alt="" /> : <div className="wf-picker-blank" />}
              <span>{ad.pageName || "Unknown"}</span>
            </button>
          ))}
          {shown.length === 0 && <p className="note">No saved ads match.</p>}
        </div>
      </Surface>
    </div>
  );
};

const RunView = ({ run, canvas, name, onClose }) => {
  const stale = isStale(run, canvas);
  return (
    <div className="modal">
      <div className="modal-backdrop" onClick={onClose} />
      <Surface className="modal-card wf-run" material="frosted" radius={18}>
        <button className="modal-close" type="button" onClick={onClose}>
          &#10005;
        </button>
        <h2>{run.concept || "Shot list"}</h2>
        <p className="note">
          {new Date(run.createdAt).toLocaleString()} · {runtimeSeconds(run.shotList)}s ·{" "}
          {run.model} · {run.promptVersion}
        </p>
        {stale && (
          <p className="note wf-stale">
            The brief has changed since this was generated. It is kept as it was;
            generate again for the current graph.
          </p>
        )}
        <h3>Shot list</h3>
        <ol className="wf-shots">
          {(run.shotList || []).map((s) => (
            <li key={s.n}>
              <span className="wf-shot-time">{s.seconds}s</span>
              <div>
                <p>{s.shot}</p>
                <p className="note">{s.why}</p>
              </div>
            </li>
          ))}
        </ol>
        <h3>Script</h3>
        <table className="wf-script">
          <tbody>
            {(run.script || []).map((line, i) => (
              <tr key={i}>
                <td className="wf-shot-time">{line.at}</td>
                <td>
                  <p>{line.line}</p>
                  {line.on_screen ? <p className="note">on screen: {line.on_screen}</p> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {run.notes ? (
          <>
            <h3>Notes</h3>
            <p className="note">{run.notes}</p>
          </>
        ) : null}
        <Button
          size="small"
          onClick={() =>
            downloadBlob(
              new Blob([runToText(run, name)], { type: "text/plain" }),
              `${(name || "canvas").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-shotlist.txt`,
            )
          }
        >
          Download as text
        </Button>
      </Surface>
    </div>
  );
};

export const CanvasView = ({ state, teamId }) => {
  const [canvases, setCanvases] = useState([]);
  const [canvas, setCanvas] = useState(null);
  const [runs, setRuns] = useState([]);
  const [picking, setPicking] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [drawing, setDrawing] = useState(null);

  const frameRef = useRef(null);
  const panRef = useRef(null);
  const edgeRef = useRef(null);
  const vpRef = useRef({ x: 60, y: 40, k: 1 });
  const [, forceRender] = useState(0);

  const ads = state.ads;
  const spaceAds = useMemo(() => {
    const ids = new Set();
    for (const l of Object.values(state.lists))
      if (l.spaceId === state.settings.activeSpaceId) for (const id of l.adIds) ids.add(id);
    return [...ids].map((id) => ads[id]).filter(Boolean);
  }, [state]);

  const load = useCallback(async () => {
    const res = await send({ type: "CANVAS_OP", op: "list" });
    const list = (res && res.canvases) || [];
    setCanvases(list);
    return list;
  }, []);

  const open = useCallback(async (id) => {
    const res = await send({ type: "CANVAS_OP", op: "get", canvasId: id });
    if (res && res.ok) {
      setCanvas(res.canvas);
      setRuns(res.runs || []);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // The graph is saved whole and debounced. A canvas is small, and a partial
  // write of a graph is worse than a slightly late one.
  const saveTimer = useRef(null);
  const persist = useCallback((next) => {
    setCanvas(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      send({ type: "CANVAS_OP", op: "save", canvasId: next.id, nodes: next.nodes, edges: next.edges });
    }, 400);
  }, []);

  // ---- viewport -----------------------------------------------------------

  const applyTransform = useCallback(() => {
    const { x, y, k } = vpRef.current;
    const css = `translate(${x}px, ${y}px) scale(${k})`;
    // Written imperatively during a gesture: setState here would re-render
    // every node, and these nodes hold controlled textareas.
    if (panRef.current) panRef.current.style.transform = css;
    if (edgeRef.current) edgeRef.current.style.transform = css;
  }, []);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      const vp = vpRef.current;
      if (e.ctrlKey || e.metaKey) {
        const rect = frame.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, vp.k * Math.exp(-e.deltaY * 0.002)));
        // Keep the point under the cursor fixed.
        vp.x = px - (px - vp.x) * (k / vp.k);
        vp.y = py - (py - vp.y) * (k / vp.k);
        vp.k = k;
      } else {
        vp.x -= e.deltaX;
        vp.y -= e.deltaY;
      }
      applyTransform();
    };
    // Not React's onWheel: that handler is registered passively at the root, so
    // preventDefault() from it is ignored and the page scrolls instead.
    frame.addEventListener("wheel", onWheel, { passive: false });
    return () => frame.removeEventListener("wheel", onWheel);
  }, [applyTransform, canvas && canvas.id]);

  useEffect(() => {
    applyTransform();
  }, [applyTransform, canvas && canvas.id]);

  const toWorld = (clientX, clientY) => {
    const rect = frameRef.current.getBoundingClientRect();
    const vp = vpRef.current;
    return {
      x: (clientX - rect.left - vp.x) / vp.k,
      y: (clientY - rect.top - vp.y) / vp.k,
    };
  };

  const panPointer = useRef(null);
  const onPanePointerDown = (e) => {
    if (e.button !== 0) return;
    // Only the empty pane starts a pan. Capturing the pointer on any press
    // retargets the following click to the pane, and an edge could then never
    // be clicked at all - the hit path would swallow the press and the pane
    // would swallow the click.
    if (e.target !== e.currentTarget) return;
    panPointer.current = { x: e.clientX, y: e.clientY, vx: vpRef.current.x, vy: vpRef.current.y };
    e.currentTarget.setPointerCapture(e.pointerId);
    frameRef.current.classList.add("panning");
  };
  const onPanePointerMove = (e) => {
    const start = panPointer.current;
    if (!start) return;
    vpRef.current.x = start.vx + (e.clientX - start.x);
    vpRef.current.y = start.vy + (e.clientY - start.y);
    applyTransform();
  };
  const endPan = () => {
    panPointer.current = null;
    if (frameRef.current) frameRef.current.classList.remove("panning");
  };

  const fit = () => {
    if (!canvas || !canvas.nodes.length) return;
    const xs = canvas.nodes.map((n) => n.x);
    const ys = canvas.nodes.map((n) => n.y);
    const minX = Math.min(...xs) - 40;
    const minY = Math.min(...ys) - 40;
    const maxX = Math.max(...xs) + NODE_WIDTH + 40;
    const maxY = Math.max(...ys) + 240;
    const rect = frameRef.current.getBoundingClientRect();
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(rect.width / (maxX - minX), rect.height / (maxY - minY))));
    vpRef.current = { k, x: -minX * k, y: -minY * k };
    applyTransform();
  };

  // ---- nodes --------------------------------------------------------------

  const dragRef = useRef(null);
  const onNodePointerDown = (e, node) => {
    if (e.button !== 0) return;
    // Without this the pane pans while a node is being dragged.
    e.stopPropagation();
    const world = toWorld(e.clientX, e.clientY);
    dragRef.current = { id: node.id, dx: world.x - node.x, dy: world.y - node.y };
    e.currentTarget.setPointerCapture(e.pointerId);
    frameRef.current.classList.add("panning");
  };
  const onNodePointerMove = (e) => {
    const drag = dragRef.current;
    if (!drag || !canvas) return;
    const world = toWorld(e.clientX, e.clientY);
    const node = canvas.nodes.find((n) => n.id === drag.id);
    if (!node) return;
    node.x = world.x - drag.dx;
    node.y = world.y - drag.dy;
    const el = frameRef.current.querySelector(`[data-node="${drag.id}"]`);
    if (el) el.style.transform = `translate(${node.x}px, ${node.y}px)`;
    forceRender((n) => n + 1);
  };
  const onNodePointerUp = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (frameRef.current) frameRef.current.classList.remove("panning");
    if (canvas) persist({ ...canvas, nodes: [...canvas.nodes] });
  };

  const addReference = (ad) => {
    setPicking(false);
    if (!canvas) return;
    const out = outputNode(canvas);
    const count = canvas.nodes.filter((n) => n.kind === "reference").length;
    const node = {
      id: uid(),
      kind: "reference",
      adId: ad.id,
      note: "",
      x: 80,
      y: 60 + count * 210,
      snapshot: snapshotOf(ad),
    };
    persist({
      ...canvas,
      nodes: [...canvas.nodes, node],
      // Wired straight in: a reference nobody connected is the common mistake,
      // and dragging the edge is the deliberate act, not the default one.
      edges: out ? [...canvas.edges, { from: node.id, to: out.id }] : canvas.edges,
    });
  };

  const addNote = () => {
    if (!canvas) return;
    const count = canvas.nodes.filter((n) => n.kind === "note").length;
    persist({
      ...canvas,
      nodes: [
        ...canvas.nodes,
        { id: uid(), kind: "note", note: "", x: 80, y: 60 + count * 160 },
      ],
    });
  };

  const setNote = (id, note) => {
    if (!canvas) return;
    persist({
      ...canvas,
      nodes: canvas.nodes.map((n) => (n.id === id ? { ...n, note } : n)),
    });
  };

  const removeNode = (id) => {
    if (!canvas) return;
    persist({
      ...canvas,
      nodes: canvas.nodes.filter((n) => n.id !== id),
      edges: canvas.edges.filter((e) => e.from !== id && e.to !== id),
    });
  };

  // ---- edges --------------------------------------------------------------

  const onPortPointerDown = (e, node) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrawing({ from: node.id, at: portOut(node) });
  };
  const onPortPointerMove = (e) => {
    if (!drawing) return;
    setDrawing({ ...drawing, at: toWorld(e.clientX, e.clientY) });
  };
  const onPortPointerUp = (e) => {
    if (!drawing) return;
    // The browser hit-tests through the viewport transform for free, which is
    // why this is elementFromPoint and not rectangle intersection.
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const target = under && under.closest("[data-port-in]");
    const toId = target && target.getAttribute("data-port-in");
    if (toId && toId !== drawing.from && canvas) {
      const exists = canvas.edges.some((edge) => edge.from === drawing.from && edge.to === toId);
      if (!exists) persist({ ...canvas, edges: [...canvas.edges, { from: drawing.from, to: toId }] });
    }
    setDrawing(null);
  };

  const dropEdge = (edge) => {
    if (!canvas) return;
    persist({
      ...canvas,
      edges: canvas.edges.filter((e) => !(e.from === edge.from && e.to === edge.to)),
    });
  };

  // ---- generation ---------------------------------------------------------

  const run = async () => {
    if (!canvas) return;
    setBusy(true);
    setError(null);
    const res = await generate(canvas, ads, { teamId });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setRuns((prev) => [res.run, ...prev]);
    setViewing(res.run);
  };

  // ---- render -------------------------------------------------------------

  if (!canvas) {
    return (
      <div className="wf-empty">
        <Surface className="discover-step" material="clear">
          <h2>Workflows</h2>
          <p className="note">
            Drop reference ads on a canvas, write on each one what to take from it
            - the hook, the lighting, the humour, the product shots - and wire
            them into the output. The notes are the brief; the canvas is just how
            you lay it out.
          </p>
          <div className="discover-row">
            <Button
              variant="primary"
              onClick={async () => {
                const name = prompt("Canvas name:", "New canvas");
                if (!name) return;
                const res = await send({ type: "CANVAS_OP", op: "create", name });
                if (res && res.ok) {
                  await load();
                  open(res.canvas.id);
                }
              }}
            >
              New canvas
            </Button>
          </div>
          {canvases.length > 0 && (
            <ul className="wf-list">
              {canvases.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => open(c.id)}>
                    {c.name}
                  </button>
                  <span className="note">
                    {(c.nodes || []).filter((n) => n.kind === "reference").length} references ·{" "}
                    {new Date(c.updatedAt).toLocaleDateString()}
                  </span>
                  <button
                    type="button"
                    className="wf-del"
                    onClick={async () => {
                      if (!confirm(`Delete "${c.name}"?`)) return;
                      await send({ type: "CANVAS_OP", op: "delete", canvasId: c.id });
                      load();
                    }}
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Surface>
      </div>
    );
  }

  const out = outputNode(canvas);
  const byId = Object.fromEntries(canvas.nodes.map((n) => [n.id, n]));
  const latest = runs[0] || null;

  return (
    <div className="wf">
      <Surface className="wf-bar" material="clear">
        <Button size="small" onClick={() => setCanvas(null)}>
          Back
        </Button>
        <strong>{canvas.name}</strong>
        <Button size="small" onClick={() => setPicking(true)}>
          + Reference
        </Button>
        <Button size="small" onClick={addNote}>
          + Note
        </Button>
        <Button size="small" onClick={fit}>
          Fit
        </Button>
        <span className="wf-spacer" />
        {latest ? (
          <Button size="small" onClick={() => setViewing(latest)}>
            {isStale(latest, canvas) ? "Last run (stale)" : "Last run"}
          </Button>
        ) : null}
        <Button variant="primary" size="small" disabled={busy} onClick={run}>
          {busy ? "Writing..." : "Generate shot list"}
        </Button>
      </Surface>

      {error ? <p className="note score-error wf-error">{error}</p> : null}

      <Surface className="wf-frame" material="clear">
        <div
          className="wf-pane"
          ref={frameRef}
          onPointerDown={onPanePointerDown}
          onPointerMove={(e) => {
            onPanePointerMove(e);
            onNodePointerMove(e);
            onPortPointerMove(e);
          }}
          onPointerUp={(e) => {
            endPan();
            onNodePointerUp();
            onPortPointerUp(e);
          }}
          onPointerCancel={() => {
            endPan();
            onNodePointerUp();
            setDrawing(null);
          }}
        >
          {/* Edges and nodes are siblings carrying the same transform: the SVG
              must not capture pointer events or nothing below it is clickable. */}
          <svg className="wf-edges" ref={edgeRef}>
            {canvas.edges.map((edge) => {
              const from = byId[edge.from];
              const to = byId[edge.to];
              if (!from || !to) return null;
              return (
                <g key={`${edge.from}-${edge.to}`}>
                  <path d={edgePath(portOut(from), portIn(to))} className="wf-edge" />
                  <path
                    d={edgePath(portOut(from), portIn(to))}
                    className="wf-edge-hit"
                    onClick={() => dropEdge(edge)}
                  />
                </g>
              );
            })}
            {drawing && byId[drawing.from] ? (
              <path
                d={edgePath(portOut(byId[drawing.from]), drawing.at)}
                className="wf-edge wf-edge-live"
              />
            ) : null}
          </svg>

          <div className="wf-nodes" ref={panRef}>
            {canvas.nodes.map((node) => {
              const ad = node.adId ? ads[node.adId] : null;
              const snap = node.snapshot || {};
              return (
                <div
                  key={node.id}
                  data-node={node.id}
                  className={`wf-node wf-node-${node.kind}`}
                  style={{ transform: `translate(${node.x}px, ${node.y}px)` }}
                  onPointerDown={(e) => onNodePointerDown(e, node)}
                >
                  <Surface className="wf-node-surface" radius={14}>
                    <header>
                      <span className="wf-node-kind">
                        {node.kind === "output"
                          ? "Output"
                          : node.kind === "note"
                            ? "Note"
                            : snap.pageName || (ad && ad.pageName) || "Reference"}
                      </span>
                      {node.kind !== "output" && (
                        <button
                          type="button"
                          className="wf-node-x"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => removeNode(node.id)}
                          aria-label="Remove node"
                        >
                          &#10005;
                        </button>
                      )}
                    </header>

                    {node.kind === "reference" && (
                      <div className="wf-node-media">
                        {ad && thumbFor(ad) ? (
                          <img src={thumbFor(ad)} alt="" />
                        ) : (
                          <div className="wf-node-gone">
                            {ad ? "no preview" : "no longer in your library"}
                          </div>
                        )}
                      </div>
                    )}

                    <textarea
                      value={node.note || ""}
                      placeholder={
                        node.kind === "output"
                          ? "The brief: format, length, platform, audience..."
                          : node.kind === "note"
                            ? "Anything else the writer should know"
                            : "What to take from this one: the hook, the lighting, the humour..."
                      }
                      // Without this you cannot select text inside a draggable
                      // node: the pointerdown starts a drag instead.
                      onPointerDown={(e) => e.stopPropagation()}
                      onChange={(e) => setNote(node.id, e.target.value)}
                      aria-label="Node note"
                    />

                    {node.kind === "reference" && snap.libraryUrl ? (
                      <a
                        href={snap.libraryUrl}
                        target="_blank"
                        rel="noreferrer"
                        onPointerDown={(e) => e.stopPropagation()}
                        className="note"
                      >
                        Open in Ad Library
                      </a>
                    ) : null}
                  </Surface>

                  {node.kind !== "output" && (
                    <span
                      className="wf-port wf-port-out"
                      onPointerDown={(e) => onPortPointerDown(e, node)}
                      title="Drag to the output"
                    />
                  )}
                  {node.kind === "output" && (
                    <span className="wf-port wf-port-in" data-port-in={node.id} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </Surface>

      <p className="note wf-hint">
        Drag to pan, pinch or ctrl-scroll to zoom, click an edge to cut it.{" "}
        {out ? `${canvas.edges.filter((e) => e.to === out.id).length} references wired in.` : ""}{" "}
        {latest && isStale(latest, canvas)
          ? "The brief has changed since the last run."
          : ""}
      </p>

      {picking && (
        <AdPicker ads={spaceAds} onPick={addReference} onClose={() => setPicking(false)} />
      )}
      {viewing && (
        <RunView run={viewing} canvas={canvas} name={canvas.name} onClose={() => setViewing(null)} />
      )}
    </div>
  );
};
