/**
 * Full dashboard.
 *
 * Same material and same refracting Surface as the side panel; this page is
 * the one with room for filters, metrics and the modals. Aggregation still
 * lives in metrics.js, which is pure and unit-tested, and the filter, sort and
 * export rules live in lib.js for the same reason.
 */
import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, GlassSystemProvider, SegmentedControl } from "open-glass-ui";
import "open-glass-ui/styles.css";
import { Surface } from "../../src/surface.jsx";
import {
  checkConnection,
  getSession,
  sendCode,
  signOut,
  verifyCode,
} from "../../src/supabase/client.js";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../../src/supabase/config.js";
import { createTeam, joinTeam, pull, push, watch } from "../../src/supabase/sync.js";
import {
  LIST_COLORS,
  M,
  adFormat,
  daysRunning,
  exportCsv,
  exportJson,
  fmtDate,
  fmtNum,
  listsForAd,
  send,
  spaceLists,
  thumbFor,
  visibleAds,
  downloadBlob,
} from "./lib.js";

const Mark = ({ id }) => (
  <svg className="mark" viewBox="0 0 24 24" aria-hidden="true">
    <defs>
      <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#4510e8" />
        <stop offset="0.55" stopColor="#ed0cdd" />
        <stop offset="1" stopColor="#ffc41d" />
      </linearGradient>
    </defs>
    <rect x="1" y="7" width="8.5" height="10" rx="2.4" fill="#9b8cf2" opacity=".5" />
    <rect x="6" y="5" width="9.5" height="14" rx="2.8" fill="#9b8cf2" opacity=".8" />
    <rect x="12" y="3" width="11" height="18" rx="3.2" fill={`url(#${id})`} />
  </svg>
);

/* ---------- charts ---------- */

const Tip = ({ html, children, className }) => {
  // One shared tooltip node, positioned from the pointer, as before.
  const show = (e) => {
    let el = document.getElementById("viz-tip");
    if (!el) {
      el = document.createElement("div");
      el.id = "viz-tip";
      document.body.appendChild(el);
    }
    el.innerHTML = html;
    el.classList.add("visible");
    const pad = 12;
    const rect = el.getBoundingClientRect();
    let x = e.clientX + pad;
    if (x + rect.width > window.innerWidth - pad) x = e.clientX - rect.width - pad;
    el.style.left = `${Math.max(pad, x)}px`;
    el.style.top = `${Math.max(pad, e.clientY - rect.height - pad)}px`;
  };
  const hide = () => {
    const el = document.getElementById("viz-tip");
    if (el) el.classList.remove("visible");
  };
  return (
    <div className={className} onMouseMove={show} onMouseLeave={hide}>
      {children}
    </div>
  );
};

const BarChart = ({ title, sub, rows, footer }) => {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <Surface className="viz">
      <div className="viz-title">{title}</div>
      <div className="viz-sub">{sub}</div>
      {rows.length === 0 ? (
        <div className="viz-empty">No data yet.</div>
      ) : (
        rows.map((row) => (
          <Tip
            key={row.label}
            className="bar-row"
            html={`<strong>${row.label}</strong><br>${fmtNum(row.value)} ad${row.value === 1 ? "" : "s"}`}
          >
            <div className="bar-label" title={row.label}>
              {row.label}
            </div>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${(row.value / max) * 100}%` }} />
            </div>
            <div className="bar-value">{M.compact(row.value)}</div>
          </Tip>
        ))
      )}
      {footer ? <div className="viz-sub" style={{ marginTop: 8 }}>{footer}</div> : null}
    </Surface>
  );
};

const SavesChart = ({ timeline }) => {
  const total = timeline.reduce((s, d) => s + d.value, 0);
  const max = Math.max(...timeline.map((d) => d.value), 1);
  const tick = (ms) =>
    new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return (
    <Surface className="viz">
      <div className="viz-title">Saves per day</div>
      <div className="viz-sub">{fmtNum(total)} saved in the last 30 days</div>
      <div className="col-chart">
        {timeline.map((d) => (
          <Tip
            key={d.ms}
            className="col-slot"
            html={`<strong>${tick(d.ms)}</strong><br>${fmtNum(d.value)} saved`}
          >
            <div
              className={`col-fill${d.value === 0 ? " zero" : ""}`}
              style={{ height: d.value === 0 ? 2 : Math.max(4, (d.value / max) * 88) }}
            />
          </Tip>
        ))}
      </div>
      <div className="col-axis">
        <span>{tick(timeline[0].ms)}</span>
        <span>{tick(timeline[timeline.length - 1].ms)}</span>
      </div>
    </Surface>
  );
};

const StackChart = ({ title, sub, rows }) => {
  const total = rows.reduce((s, r) => s + r.value, 0);
  return (
    <Surface className="viz">
      <div className="viz-title">{title}</div>
      <div className="viz-sub">{sub}</div>
      {total === 0 ? (
        <div className="viz-empty">No data yet.</div>
      ) : (
        <>
          <div className="stack">
            {rows.map((row, i) =>
              row.value === 0 ? null : (
                <Tip
                  key={row.label}
                  className="stack-seg"
                  html={`<strong>${row.label}</strong><br>${fmtNum(row.value)} ads · ${Math.round((row.value / total) * 100)}%`}
                >
                  <div
                    style={{
                      flex: row.value,
                      background: `var(--series-${i + 1})`,
                      height: "100%",
                    }}
                  />
                </Tip>
              ),
            )}
          </div>
          {/* Legend carries identity and values, so colour is never the only cue. */}
          <div className="legend">
            {rows.map((row, i) => (
              <span className="legend-item" key={row.label}>
                <span className="legend-dot" style={{ background: `var(--series-${i + 1})` }} />
                {row.label}
                <span className="legend-value">{fmtNum(row.value)}</span>
              </span>
            ))}
          </div>
        </>
      )}
    </Surface>
  );
};

/* ---------- ad card ---------- */

const AdCard = ({ ad, state, selected, onToggle, onOpen, activeList }) => {
  const [label, setLabel] = useState("Download");
  const thumb = thumbFor(ad);
  const format = adFormat(ad);
  const days = daysRunning(ad);
  const chips = [];
  for (const list of listsForAd(state, ad.id))
    chips.push(
      <span className="chip list-chip" key={`l${list.id}`}>
        <span className="legend-dot" style={{ background: list.color }} />
        {list.name}
      </span>,
    );
  if (days != null)
    chips.push(
      <span className={`chip ${days >= 30 ? "hot" : ""}`} key="days">
        {days}d running
      </span>,
    );
  for (const p of (ad.platforms || []).slice(0, 3))
    chips.push(<span className="chip" key={`p${p}`}>{String(p).toLowerCase()}</span>);
  if (ad.ctaText) chips.push(<span className="chip" key="cta">{ad.ctaText}</span>);

  return (
    <Surface className={`card${selected ? " selected" : ""}`}>
      <input
        type="checkbox"
        className="card-check"
        checked={selected}
        onChange={(e) => onToggle(ad.id, e.target.checked)}
        aria-label={`Select ${ad.pageName || "ad"}`}
      />
      <div className="card-media" onClick={() => onOpen(ad)}>
        {thumb ? (
          <img src={thumb} loading="lazy" alt="" />
        ) : (
          <div className="media-placeholder">{format}</div>
        )}
        {ad.isActive === true && <span className="badge active-badge">ACTIVE</span>}
        {ad.isActive === false && <span className="badge inactive-badge">ENDED</span>}
        <span className="badge">{format.toUpperCase()}</span>
      </div>
      <div className="card-body">
        <div className="card-advertiser">
          {ad.pageProfilePictureUrl && <img src={ad.pageProfilePictureUrl} alt="" />}
          <span className="adv-name">{ad.pageName || "Unknown page"}</span>
        </div>
        <div className="card-meta">
          {fmtDate(ad.startDate)}
          {ad.endDate ? ` → ${fmtDate(ad.endDate)}` : ""}
          {ad.savedBy ? ` · by ${ad.savedBy}` : ""}
        </div>
        <div className="chips">{chips}</div>
        {ad.body && <div className="card-copy">{ad.body}</div>}
        <div className="card-actions">
          <Button size="small" onClick={() => onOpen(ad)}>
            Details
          </Button>
          <Button
            size="small"
            variant="primary"
            onClick={async () => {
              setLabel("...");
              const res = await send({
                type: "DOWNLOAD_AD",
                ad,
                listId: activeList === "__all__" ? null : activeList,
              });
              setLabel(res.ok ? `Got ${res.count}${res.quality === "hd" ? " HD" : ""}` : "Failed");
              setTimeout(() => setLabel("Download"), 2200);
            }}
          >
            {label}
          </Button>
        </div>
      </div>
    </Surface>
  );
};

/* ---------- modals ---------- */

const Modal = ({ onClose, children }) => (
  <div className="modal">
    <div className="modal-backdrop" onClick={onClose} />
    <Surface className="modal-card" material="frosted" radius={18}>
      <button className="modal-close" type="button" onClick={onClose}>
        &#10005;
      </button>
      {children}
    </Surface>
  </div>
);

const AdDetail = ({ ad, onClose }) => {
  const rows = [
    ["Advertiser", ad.pageName],
    ["Library ID", ad.id],
    ["Status", ad.isActive === true ? "Active" : ad.isActive === false ? "Ended" : "Unknown"],
    ["Started", fmtDate(ad.startDate)],
    ["Ended", ad.endDate ? fmtDate(ad.endDate) : "-"],
    ["Days running", daysRunning(ad)],
    ["Platforms", (ad.platforms || []).join(", ")],
    ["Format", adFormat(ad)],
    ["Variations", ad.collationCount],
    ["Title", ad.title],
    ["Body", ad.body],
    ["CTA", ad.ctaText ? `${ad.ctaText}${ad.ctaType ? ` (${ad.ctaType})` : ""}` : null],
    ["Destination", ad.linkUrl],
    ["Page likes", ad.pageLikeCount != null ? fmtNum(ad.pageLikeCount) : null],
    ["Saved by", ad.savedBy],
    ["Saved", ad.savedAt ? new Date(ad.savedAt).toLocaleString() : null],
    // Disclosure-only fields: shown when Meta published them, never as a
    // permanent "not disclosed" row for ordinary commercial ads.
    ["Spend (disclosed)", ad.spend ? `${ad.spend} ${ad.currency || ""}` : null],
    ["Impressions (disclosed)", ad.impressionsText],
    ["EU reach (disclosed)", ad.euTotalReach != null ? fmtNum(ad.euTotalReach) : null],
  ].filter(([, v]) => v != null && v !== "");

  return (
    <Modal onClose={onClose}>
      <h2>{ad.pageName || "Unknown page"}</h2>
      <p>
        <a href={ad.libraryUrl} target="_blank" rel="noreferrer">
          Open in Meta Ad Library
        </a>
        {ad.linkUrl && (
          <>
            {" · "}
            <a href={ad.linkUrl} target="_blank" rel="noreferrer">
              Landing page
            </a>
          </>
        )}
      </p>
      <div className="modal-media">
        {(ad.media || []).length === 0 ? (
          <div className="note">
            No media captured. Synced ads carry no media URLs, since Meta's signed
            links expire.
          </div>
        ) : (
          ad.media.map((m, i) =>
            m.type === "video" ? (
              <video key={i} controls preload="metadata" poster={m.previewUrl || undefined}>
                <source src={m.hdUrl || m.sdUrl || m.url} />
              </video>
            ) : (
              <img key={i} src={m.url} alt="" />
            ),
          )
        )}
      </div>
      <table className="detail-table">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <td>{String(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
};

const ListSettings = ({ list, onClose, onDone, activeList, setActiveList }) => {
  const [name, setName] = useState(list.name);
  const [color, setColor] = useState(list.color);
  return (
    <Modal onClose={onClose}>
      <h2>List settings</h2>
      <div className="form-row">
        <label className="field-label" htmlFor="list-name">Name</label>
        <input id="list-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="form-row">
        <label className="field-label">Label colour</label>
        <div className="swatches">
          {LIST_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`swatch${c === color ? " selected" : ""}`}
              style={{ background: c }}
              aria-label={c}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
      </div>
      <div className="modal-actions">
        <Button
          variant="primary"
          onClick={async () => {
            const trimmed = name.trim();
            if (trimmed && trimmed !== list.name)
              await send({ type: "LIST_OP", op: "rename", listId: list.id, name: trimmed });
            if (color !== list.color)
              await send({ type: "LIST_OP", op: "recolor", listId: list.id, color });
            onClose();
            onDone();
          }}
        >
          Save
        </Button>
        <Button
          variant="danger"
          onClick={async () => {
            if (!confirm(`Delete the list "${list.name}"?`)) return;
            await send({ type: "LIST_OP", op: "delete", listId: list.id });
            if (activeList === list.id) setActiveList("__all__");
            onClose();
            onDone();
          }}
        >
          Delete list
        </Button>
      </div>
      <p className="note">
        Deleting a list keeps its ads in the space if they are also in another list.
      </p>
    </Modal>
  );
};

const TeamModal = ({ space, state, onClose, onDone, onImport, setActiveList }) => {
  const isTeam = space && space.kind === "team";
  const linked = !!(space && space.teamId);
  const [session, setSession] = useState(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    getSession().then(setSession);
  }, []);

  const lists = spaceLists(state);

  const run = async (label, fn) => {
    setBusy(label);
    setNote("");
    const res = await fn();
    setBusy("");
    setNote(res.ok ? res.message || "Done." : res.error || "Failed.");
    if (res.ok) onDone();
  };

  return (
    <Modal onClose={onClose}>
      <h2>Team spaces</h2>

      {isTeam ? (
        <>
          <p>
            Share this code so teammates can join <strong>{space.name}</strong>.
          </p>
          <div className="code-display">{space.code}</div>
        </>
      ) : (
        <p>
          <strong>{space && space.name}</strong> is a personal space. Make it a
          team space to share it, or join someone else's with their code.
        </p>
      )}

      {!session ? (
        <p className="note">
          Sign in under Settings to use live sync. Without it, the file export
          below still works: it is a snapshot rather than a live space.
        </p>
      ) : (
        <>
          <div className="modal-actions">
            {!linked && (
              <>
                <Button
                  variant="primary"
                  disabled={!!busy}
                  onClick={() =>
                    run("create", async () => {
                      const res = await createTeam(space.id, space.name);
                      return res.ok
                        ? { ok: true, message: `Team created. Code ${res.team.join_code}.` }
                        : res;
                    })
                  }
                >
                  {busy === "create" ? "Creating..." : "Make this a team space"}
                </Button>
              </>
            )}
            {linked && (
              <>
                <Button
                  variant="primary"
                  disabled={!!busy}
                  onClick={() =>
                    run("push", async () => {
                      const res = await push(space, lists, state.ads);
                      return res.ok
                        ? { ok: true, message: `Pushed ${res.ads} ads and ${res.lists} lists.` }
                        : res;
                    })
                  }
                >
                  {busy === "push" ? "Pushing..." : "Push now"}
                </Button>
                <Button
                  disabled={!!busy}
                  onClick={() =>
                    run("pull", async () => {
                      const res = await pull(space, lists, state.ads);
                      return res.ok
                        ? {
                            ok: true,
                            message: `Pulled ${res.ads} ads and ${res.lists} lists${res.removed ? `, removed ${res.removed}` : ""}.`,
                          }
                        : res;
                    })
                  }
                >
                  {busy === "pull" ? "Pulling..." : "Pull now"}
                </Button>
              </>
            )}
          </div>

          {!linked && (
            <>
              <div className="form-row">
                <label className="field-label" htmlFor="join-code">Join code</label>
                <input
                  id="join-code"
                  type="text"
                  value={code}
                  placeholder="six characters"
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                />
              </div>
              <div className="modal-actions">
                <Button
                  disabled={!!busy || code.length < 6}
                  onClick={() =>
                    run("join", async () => {
                      const res = await joinTeam(space.id, code);
                      if (!res.ok) return res;
                      setActiveList("__all__");
                      const pulled = await pull({ ...space, teamId: res.team.id }, lists, state.ads);
                      return {
                        ok: true,
                        message: pulled.ok
                          ? `Joined ${res.team.name}. Pulled ${pulled.ads} ads.`
                          : `Joined ${res.team.name}.`,
                      };
                    })
                  }
                >
                  {busy === "join" ? "Joining..." : "Join with code"}
                </Button>
              </div>
            </>
          )}
        </>
      )}

      {note && <p className="note">{note}</p>}

      <div className="toggle-row">
        <div className="toggle-text">
          <div><strong>Export and import a file</strong></div>
          <div className="toggle-sub">
            The serverless route, kept because it needs no account: everyone's
            lists merge on the join code. It is a snapshot, so re-export after
            adding ads.
          </div>
        </div>
      </div>
      <div className="modal-actions">
        {isTeam && (
          <Button
            onClick={async () => {
              const res = await send({ type: "EXPORT_SPACE", spaceId: space.id });
              if (!res.ok) return;
              downloadBlob(
                JSON.stringify(res.payload, null, 2),
                `${space.name.replace(/\s+/g, "-").toLowerCase()}-${space.code}.json`,
                "application/json",
              );
            }}
          >
            Export space file
          </Button>
        )}
        <Button onClick={onImport}>Join / merge from file</Button>
      </div>
    </Modal>
  );
};

/**
 * Team sync setup.
 *
 * The status is three separate facts rather than one "connected" light,
 * because they fail independently and each has a different fix: the project
 * can be unreachable, reachable but without the schema, or ready but not
 * signed in.
 */
const TeamSync = () => {
  const [config, setConfig] = useState({ url: "", anonKey: "" });
  const [status, setStatus] = useState(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState("idle");
  const [note, setNote] = useState("");

  const reload = useCallback(async () => {
    setConfig(await loadConfig());
    setStatus(await checkConnection());
    const session = await getSession();
    if (session && session.user) setEmail(session.user.email || "");
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const light = (on, label, hint) => (
    <div className="sync-row" key={label}>
      <span className={`sync-dot${on ? " on" : ""}`} aria-hidden="true" />
      <span className="sync-label">{label}</span>
      <span className="sync-hint">{on ? "yes" : hint}</span>
    </div>
  );

  return (
    <>
      <div className="toggle-row">
        <div className="toggle-text">
          <div><strong>Team sync</strong></div>
          <div className="toggle-sub">
            A Supabase project holds the shared space. The publishable key is
            safe here; the database password and service_role key are not, and
            are never needed.
          </div>
        </div>
      </div>

      {status && (
        <div className="sync-status">
          {light(status.configured, "Project configured", "add the URL and key")}
          {light(status.reachable, "Project reachable", "check the URL")}
          {light(status.schema, "Schema applied", "run supabase/schema.sql")}
          {light(status.signedIn, "Signed in", "sign in below")}
        </div>
      )}

      <div className="form-row">
        <label className="field-label" htmlFor="sb-url">Project URL</label>
        <input
          id="sb-url"
          type="text"
          value={config.url}
          placeholder={DEFAULT_CONFIG.url}
          onChange={(e) => setConfig((c) => ({ ...c, url: e.target.value }))}
        />
      </div>
      <div className="form-row">
        <label className="field-label" htmlFor="sb-key">Publishable key</label>
        <input
          id="sb-key"
          type="text"
          value={config.anonKey}
          placeholder="sb_publishable_..."
          onChange={(e) => setConfig((c) => ({ ...c, anonKey: e.target.value }))}
        />
      </div>
      <div className="modal-actions">
        <Button
          onClick={async () => {
            await saveConfig(config);
            setNote("Saved. Re-checking...");
            await reload();
            setNote("");
          }}
        >
          Save project
        </Button>
      </div>

      <div className="toggle-row">
        <div className="toggle-text">
          <div><strong>{status && status.signedIn ? "Signed in" : "Sign in"}</strong></div>
          <div className="toggle-sub">
            A six-digit code by email. No password, and no redirect to register.
          </div>
        </div>
      </div>

      {status && status.signedIn ? (
        <div className="modal-actions">
          <Button
            onClick={async () => {
              await signOut();
              setStage("idle");
              setCode("");
              await reload();
            }}
          >
            Sign out
          </Button>
        </div>
      ) : (
        <>
          <div className="form-row">
            <input
              type="email"
              value={email}
              placeholder="you@example.com"
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          {stage === "sent" && (
            <div className="form-row">
              <input
                type="text"
                inputMode="numeric"
                value={code}
                placeholder="six-digit code"
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
          )}
          <div className="modal-actions">
            {stage === "sent" ? (
              <Button
                variant="primary"
                onClick={async () => {
                  setNote("Checking...");
                  const res = await verifyCode(email, code);
                  setNote(res.ok ? "" : res.error);
                  if (res.ok) {
                    setStage("idle");
                    await reload();
                  }
                }}
              >
                Verify code
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={async () => {
                  setNote("Sending...");
                  const res = await sendCode(email);
                  setNote(res.ok ? "Check your email for the code." : res.error);
                  if (res.ok) setStage("sent");
                }}
              >
                Email me a code
              </Button>
            )}
          </div>
        </>
      )}

      {(note || (status && status.error)) && (
        <p className="note">{note || status.error}</p>
      )}
    </>
  );
};

const SettingsModal = ({ state, onClose, onDone }) => {
  const [status, setStatus] = useState(null);
  const [displayName, setDisplayName] = useState(state.identity.displayName || "Me");

  useEffect(() => {
    send({ type: "SYNC_STATUS" }).then(setStatus);
  }, []);

  const pct = status && status.bytes ? Math.round((status.bytes / status.quota) * 100) : 0;

  return (
    <Modal onClose={onClose}>
      <h2>Settings</h2>
      <div className="toggle-row">
        <div className="toggle-text">
          <div><strong>Sync across devices</strong></div>
          <div className="toggle-sub">
            Uses the Chrome profile you are already signed into, so there is no
            separate account. Chrome caps this at about 100KB, so thumbnails and media
            links are not synced and very large libraries sync only the most recent ads.
          </div>
        </div>
        <input
          type="checkbox"
          checked={!!(status && status.enabled)}
          onChange={async (e) => {
            const res = await send({ type: "SYNC_SET", enabled: e.target.checked });
            if (!res.ok) alert("Could not change sync: " + (res.error || "unknown error"));
            onClose();
            onDone();
          }}
          aria-label="Sync across devices"
        />
      </div>

      {status && status.enabled && (
        <>
          <p className="note">
            Using {fmtNum(status.bytes || 0)} of {fmtNum(status.quota)} bytes ({pct}%).
            {status.meta
              ? ` ${fmtNum(status.meta.synced)} of ${fmtNum(status.meta.total)} ads synced.`
              : ""}
          </p>
          <div className="modal-actions">
            <Button
              variant="primary"
              onClick={async () => {
                const res = await send({ type: "SYNC_PUSH" });
                alert(
                  res.ok
                    ? `Synced ${res.synced} of ${res.total} ads.${res.truncated ? " The library exceeds Chrome's sync quota, so the oldest saves were left out." : ""}`
                    : "Push failed: " + (res.error || "unknown"),
                );
              }}
            >
              Push now
            </Button>
            <Button
              onClick={async () => {
                const res = await send({ type: "SYNC_PULL" });
                alert(res.ok ? `Pulled ${res.pulled} new ads.` : "Pull failed");
                onDone();
              }}
            >
              Pull now
            </Button>
          </div>
        </>
      )}

      <TeamSync />

      <div className="toggle-row">
        <div className="toggle-text">
          <div><strong>Appearance</strong></div>
          <div className="toggle-sub">Applies to the dashboard and the side panel.</div>
        </div>
      </div>
      <div className="form-row">
        <select
          value={state.settings.theme || "system"}
          onChange={async (e) => {
            await send({ type: "SET_THEME", theme: e.target.value });
            onDone();
          }}
        >
          <option value="system">Match system</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>

      <div className="toggle-row">
        <div className="toggle-text">
          <div><strong>Download folders</strong></div>
          <div className="toggle-sub">Where creatives land under Downloads/MetaAdsLibrary.</div>
        </div>
      </div>
      <div className="form-row">
        <select
          value={state.settings.downloadFolder || "list"}
          onChange={async (e) => {
            await send({ type: "SET_DOWNLOAD_FOLDER", mode: e.target.value });
            onDone();
          }}
        >
          <option value="list">One folder per list</option>
          <option value="advertiser">One folder per advertiser</option>
          <option value="flat">No subfolders</option>
        </select>
      </div>

      <div className="toggle-row">
        <div className="toggle-text">
          <div><strong>Display name</strong></div>
          <div className="toggle-sub">Shown against ads you save in a team space.</div>
        </div>
      </div>
      <div className="form-row">
        <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </div>
      <div className="modal-actions">
        <Button
          variant="primary"
          onClick={async () => {
            const name = displayName.trim();
            if (!name) return;
            const { identity = {} } = await chrome.storage.local.get("identity");
            identity.displayName = name;
            await chrome.storage.local.set({ identity });
            onClose();
            onDone();
          }}
        >
          Save name
        </Button>
      </div>
    </Modal>
  );
};

/* ---------- app ---------- */

const App = () => {
  const [state, setState] = useState({
    spaces: {},
    lists: {},
    ads: {},
    settings: {},
    identity: {},
  });
  const [ui, setUi] = useState({
    activeList: "__all__",
    search: "",
    format: "",
    status: "",
    sort: "saved",
  });
  const [selected, setSelected] = useState(() => new Set());
  const [modal, setModal] = useState(null);
  const [metricsOpen, setMetricsOpen] = useState(() => {
    try {
      return localStorage.getItem("mal.metricsCollapsed") === "0";
    } catch {
      return false;
    }
  });

  const refresh = useCallback(async () => {
    const res = await send({ type: "GET_STATE" });
    if (!res.ok) return;
    setState({
      spaces: res.spaces || {},
      lists: res.lists || {},
      ads: res.ads || {},
      settings: res.settings || {},
      identity: res.identity || {},
    });
  }, []);

  useEffect(() => {
    refresh();
    const onChanged = (_c, area) => {
      if (area === "local") refresh();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [refresh]);

  // An active list that no longer exists, or a selection whose ads were
  // deleted, would otherwise linger after a refresh.
  useEffect(() => {
    if (ui.activeList !== "__all__" && !state.lists[ui.activeList])
      setUi((u) => ({ ...u, activeList: "__all__" }));
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => state.ads[id]));
      return next.size === prev.size ? prev : next;
    });
  }, [state, ui.activeList]);

  const dark =
    state.settings.theme === "dark" ||
    (["system", undefined].includes(state.settings.theme) &&
      typeof matchMedia === "function" &&
      matchMedia("(prefers-color-scheme: dark)").matches);

  // Stamp the resolved appearance, never "system" and never nothing: the page
  // stylesheet keys off this attribute, so leaving it unset left the ground on
  // its dark default while the library resolved the material to light.
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);

  const lists = spaceLists(state);
  const space = state.spaces[state.settings.activeSpaceId] || null;
  const ads = useMemo(() => visibleAds(state, ui), [state, ui]);
  const agg = useMemo(() => M.aggregate(ads), [ads]);

  const allCount = useMemo(() => {
    const all = new Set();
    for (const l of lists) for (const id of l.adIds) all.add(id);
    return all.size;
  }, [lists]);

  const toggle = (id, on) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const tiles = [
    { label: "Ads in view", value: fmtNum(agg.total) },
    { label: "Advertisers", value: fmtNum(agg.advertiserCount) },
    { label: "Active now", value: fmtNum(agg.active) },
    { label: "Running 30d+", value: fmtNum(agg.longRunners), note: "the public winner signal" },
    {
      label: "Avg days running",
      value: agg.avgDaysRunning == null ? "-" : fmtNum(agg.avgDaysRunning),
      note: agg.maxDaysRunning ? `longest ${fmtNum(agg.maxDaysRunning)}d` : "",
    },
    {
      label: "Saved this week",
      value: fmtNum(agg.saves.week),
      note: `${agg.saves.today} today · ${agg.saves.month} in 30d`,
    },
  ];
  if (space && space.kind === "team")
    tiles.push({
      label: "Contributors",
      value: fmtNum(agg.contributors.rows.length),
      note: agg.contributors.rows.length ? `top: ${agg.contributors.rows[0].label}` : "",
    });

  // Realtime lives in the page, never in the service worker: a worker is
  // killed after about thirty seconds of idle and would take the socket with
  // it. Every wake re-pulls regardless, because a socket that was closed while
  // the page was shut cannot report what it missed.
  useEffect(() => {
    if (!space || !space.teamId) return;
    let stop = () => {};
    let cancelled = false;
    const go = async () => {
      const lists = spaceLists(state);
      await pull(space, lists, state.ads);
      if (cancelled) return;
      stop = await watch(space, () => pull(space, spaceLists(state), state.ads).then(refresh));
      refresh();
    };
    go();
    return () => {
      cancelled = true;
      stop();
    };
    // Re-subscribing on every store change would thrash the socket, so this
    // keys on the team alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space && space.teamId]);

  const importFile = () => document.getElementById("import-file").click();

  // The file input lives outside the React tree so the modal can be closed
  // while the browser's picker is open without unmounting it.
  useEffect(() => {
    const input = document.getElementById("import-file");
    if (!input) return;
    const onPick = async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!file) return;
      try {
        const payload = JSON.parse(await file.text());
        const res = await send({ type: "IMPORT_SPACE", payload });
        if (!res.ok) {
          alert("That file is not a valid space export.");
          return;
        }
        setModal(null);
        setUi((u) => ({ ...u, activeList: "__all__" }));
        await refresh();
        alert(
          `Merged ${res.addedAds} new ads and ${res.addedLists} lists from ${res.from} into "${res.spaceName}".`,
        );
      } catch (err) {
        alert("Could not read that file.");
      }
    };
    input.addEventListener("change", onPick);
    return () => input.removeEventListener("change", onPick);
  }, [refresh]);

  return (
    <GlassSystemProvider
      renderer="auto"
      toasts={false}
      theme={{
        appearance: dark ? "dark" : "light",
        className: "app-shell",
        theme: { accent: "#4510e8", radius: "soft" },
      }}
    >
      <Surface id="sidebar" className="sidebar" material="clear">
        <div className="brand">
          <span className="brand-mark">
            <Mark id="markSidebar" />
          </span>
          <div className="brand-text">
            <div className="brand-name">Ads Saver</div>
            <div className="brand-sub">Meta Ad Library</div>
          </div>
        </div>

        <div className="space-switch">
          <label className="field-label" htmlFor="space-select">Space</label>
          <select
            id="space-select"
            value={state.settings.activeSpaceId || ""}
            onChange={async (e) => {
              await send({ type: "SPACE_OP", op: "activate", spaceId: e.target.value });
              setUi((u) => ({ ...u, activeList: "__all__" }));
              setSelected(new Set());
              refresh();
            }}
          >
            {Object.values(state.spaces)
              .sort((a, b) => a.createdAt - b.createdAt)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.kind === "team" ? " (team)" : ""}
                </option>
              ))}
          </select>
          <div className="space-meta">
            {space && space.kind === "team" ? (
              <>Join code <span className="space-code">{space.code}</span></>
            ) : (
              "Personal space, private to this browser."
            )}
          </div>
          <div className="space-actions">
            <Button
              size="small"
              onClick={async () => {
                const name = prompt("Name this space:", "New space");
                if (!name) return;
                await send({ type: "SPACE_OP", op: "create", kind: "personal", name });
                refresh();
              }}
            >
              New
            </Button>
            <Button size="small" onClick={() => setModal({ kind: "team" })}>
              Team
            </Button>
          </div>
        </div>

        <nav id="nav-lists">
          <button
            type="button"
            className={`nav-item${ui.activeList === "__all__" ? " active" : ""}`}
            onClick={() => {
              setUi((u) => ({ ...u, activeList: "__all__" }));
              setSelected(new Set());
            }}
          >
            <span className="nav-dot all-dot" />
            <span className="nav-name">All ads</span>
            <span className="nav-count">{allCount}</span>
          </button>
          {lists.map((list) => (
            <button
              key={list.id}
              type="button"
              className={`nav-item${ui.activeList === list.id ? " active" : ""}`}
              onClick={() => {
                setUi((u) => ({ ...u, activeList: list.id }));
                setSelected(new Set());
              }}
            >
              <span className="nav-dot" style={{ background: list.color }} />
              <span className="nav-name">{list.name}</span>
              <span className="nav-count">{list.adIds.length}</span>
              <span
                className="nav-menu"
                title="List options"
                onClick={(e) => {
                  e.stopPropagation();
                  setModal({ kind: "list", list });
                }}
              >
                &#8942;
              </span>
            </button>
          ))}
        </nav>

        <Button
          onClick={async () => {
            const name = prompt("List name:");
            if (!name) return;
            await send({ type: "LIST_OP", op: "create", name });
            refresh();
          }}
        >
          + New list
        </Button>

        <Button variant="primary" onClick={() => send({ type: "OPEN_LIBRARY" })}>
          Go to Ad Library
        </Button>

        <div className="sidebar-footer">
          <Button size="small" onClick={() => exportJson(ads)}>JSON</Button>
          <Button size="small" onClick={() => exportCsv(state, ads)}>CSV</Button>
          <Button size="small" onClick={() => setModal({ kind: "settings" })}>Settings</Button>
        </div>
      </Surface>

      <main id="main">
        <Surface id="topbar" className="topbar" material="clear">
          <input
            id="search"
            type="search"
            placeholder="Search advertiser, copy, CTA, link..."
            value={ui.search}
            onChange={(e) => setUi((u) => ({ ...u, search: e.target.value.trim() }))}
          />
          <select
            value={ui.format}
            onChange={(e) => setUi((u) => ({ ...u, format: e.target.value }))}
            aria-label="Format"
          >
            <option value="">All formats</option>
            <option value="video">Video</option>
            <option value="image">Image</option>
            <option value="carousel">Carousel</option>
          </select>
          <select
            value={ui.status}
            onChange={(e) => setUi((u) => ({ ...u, status: e.target.value }))}
            aria-label="Status"
          >
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
          <select
            value={ui.sort}
            onChange={(e) => setUi((u) => ({ ...u, sort: e.target.value }))}
            aria-label="Sort"
          >
            <option value="saved">Recently saved</option>
            <option value="running">Longest running</option>
            <option value="started">Newest ads</option>
            <option value="advertiser">Advertiser A-Z</option>
          </select>
        </Surface>

        <section className="stats">
          {tiles.map((t) => (
            <Surface className="stat" key={t.label}>
              <div className="stat-value">{t.value}</div>
              <div className="stat-label">{t.label}</div>
              {t.note ? <div className="stat-note">{t.note}</div> : null}
            </Surface>
          ))}
        </section>

        <Surface className="metrics" material="clear">
          <div className="metrics-head">
            <h2>Metrics</h2>
            <Button
              size="small"
              onClick={() => {
                const next = !metricsOpen;
                setMetricsOpen(next);
                try {
                  localStorage.setItem("mal.metricsCollapsed", next ? "0" : "1");
                } catch {
                  /* storage blocked; the toggle still works this session */
                }
              }}
            >
              {metricsOpen ? "Hide" : "Show"}
            </Button>
          </div>
          {metricsOpen && (
            <div className="metrics-body">
              {agg.total === 0 ? (
                <div className="viz-empty">Save some ads to see metrics.</div>
              ) : (
                <>
                  <SavesChart timeline={agg.saves.timeline} />
                  <BarChart
                    title="Top advertisers"
                    sub="saved ads per advertiser"
                    rows={agg.advertisers.rows}
                    footer={
                      agg.advertisers.otherCount
                        ? `+ ${agg.advertisers.otherCount} more (${agg.advertisers.otherValue} ads)`
                        : ""
                    }
                  />
                  <StackChart
                    title="Format mix"
                    sub="share of saved ads by creative type"
                    rows={[
                      { label: "Video", value: agg.formatCounts.video },
                      { label: "Image", value: agg.formatCounts.image },
                      { label: "Carousel", value: agg.formatCounts.carousel },
                      { label: "Text only", value: agg.formatCounts.text },
                    ]}
                  />
                  <BarChart
                    title="Placements"
                    sub="ads running on each platform"
                    rows={agg.platformCounts.rows}
                    footer=""
                  />
                  {space && space.kind === "team" && agg.contributors.rows.length > 0 && (
                    <BarChart
                      title="Contributors"
                      sub="ads saved by each teammate"
                      rows={agg.contributors.rows}
                      footer=""
                    />
                  )}
                </>
              )}
            </div>
          )}
        </Surface>

        {selected.size > 0 && (
          <Surface className="bulkbar" material="clear">
            <span>{selected.size} selected</span>
            <select id="bulk-list-target" disabled={lists.length === 0} aria-label="Target list">
              {lists.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
            <Button
              size="small"
              variant="primary"
              onClick={async () => {
                const listId = document.getElementById("bulk-list-target").value;
                if (!listId) return;
                await send({ type: "LIST_OP", op: "add_ads", listId, adIds: [...selected] });
                setSelected(new Set());
                refresh();
              }}
            >
              Add to list
            </Button>
            <Button
              size="small"
              onClick={async () => {
                for (const id of selected) {
                  const ad = state.ads[id];
                  if (ad)
                    await send({
                      type: "DOWNLOAD_AD",
                      ad,
                      listId: ui.activeList === "__all__" ? null : ui.activeList,
                    });
                }
              }}
            >
              Download
            </Button>
            <Button
              size="small"
              variant="danger"
              onClick={async () => {
                const ids = [...selected];
                if (ui.activeList === "__all__") {
                  if (!confirm(`Delete ${ids.length} ad(s) from every list in this space?`))
                    return;
                  await send({ type: "DELETE_ADS", adIds: ids });
                } else {
                  await send({
                    type: "LIST_OP",
                    op: "remove_ads",
                    listId: ui.activeList,
                    adIds: ids,
                  });
                }
                setSelected(new Set());
                refresh();
              }}
            >
              {ui.activeList === "__all__" ? "Delete" : "Remove from list"}
            </Button>
            <Button size="small" onClick={() => setSelected(new Set())}>Clear</Button>
          </Surface>
        )}

        <section className="grid">
          {ads.map((ad) => (
            <AdCard
              key={ad.id}
              ad={ad}
              state={state}
              selected={selected.has(ad.id)}
              onToggle={toggle}
              onOpen={(a) => setModal({ kind: "ad", ad: a })}
              activeList={ui.activeList}
            />
          ))}
        </section>

        {ads.length === 0 && (
          <div className="empty">
            <div className="empty-mark">
              <Mark id="markEmpty" />
            </div>
            <h2>No ads here yet</h2>
            <p>
              Browse the{" "}
              <a href="https://www.facebook.com/ads/library/" target="_blank" rel="noreferrer">
                Meta Ad Library
              </a>
              , scroll the results, then hit <strong>Save</strong> on any ad. Use the
              caret beside Save to drop it straight into a list.
            </p>
          </div>
        )}
      </main>

      {modal && modal.kind === "ad" && (
        <AdDetail ad={modal.ad} onClose={() => setModal(null)} />
      )}
      {modal && modal.kind === "list" && (
        <ListSettings
          list={modal.list}
          onClose={() => setModal(null)}
          onDone={refresh}
          activeList={ui.activeList}
          setActiveList={(v) => setUi((u) => ({ ...u, activeList: v }))}
        />
      )}
      {modal && modal.kind === "team" && (
        <TeamModal
          space={space}
          state={state}
          onClose={() => setModal(null)}
          onDone={refresh}
          onImport={importFile}
          setActiveList={(v) => setUi((u) => ({ ...u, activeList: v }))}
        />
      )}
      {modal && modal.kind === "settings" && (
        <SettingsModal state={state} onClose={() => setModal(null)} onDone={refresh} />
      )}
    </GlassSystemProvider>
  );
};

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
