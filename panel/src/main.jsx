/**
 * Side panel, built on OpenGlass UI.
 *
 * React is here for one reason: the explicit SVG/SDF refraction, which needs
 * the library's runtime to generate a displacement map per surface geometry.
 * Everything else could have stayed vanilla, and the content script still is.
 *
 * Surfaces pass renderer="sdf-svg" to opt into refraction. The provider stays on
 * "auto" so anything that does not ask for it falls back to the CSS material,
 * and so a browser without SVG filter support degrades rather than breaking.
 */
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, GlassSystemProvider, SegmentedControl, Stat } from "open-glass-ui";
import "open-glass-ui/styles.css";
import { Surface } from "../../src/surface.jsx";
import {
  askPage,
  daysRunning,
  formatOf,
  listsForAd,
  openInLibrary,
  savedInSpace,
  send,
  thumbOf,
} from "./lib.js";

const ICONS = {
  home: "M3 9.5L10 4l7 5.5V16a1 1 0 01-1 1h-4v-4H8v4H4a1 1 0 01-1-1V9.5z",
  saved: "M5 3h10a1 1 0 011 1v13l-6-3.5L4 17V4a1 1 0 011-1z",
  lists: "M3 5h3v3H3V5zm5 .5h9v2H8v-2zM3 11h3v3H3v-3zm5 .5h9v2H8v-2z",
  account:
    "M10 10a3.5 3.5 0 100-7 3.5 3.5 0 000 7zm0 1.8c-3.3 0-6 1.8-6 4v1.2h12V15.8c0-2.2-2.7-4-6-4z",
};

const Icon = ({ name }) => (
  <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
    <path d={name} fill="currentColor" />
  </svg>
);

const Mark = () => (
  <svg className="mark" viewBox="0 0 24 24" aria-hidden="true">
    <defs>
      <linearGradient id="markGrad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#4510e8" />
        <stop offset="0.55" stopColor="#ed0cdd" />
        <stop offset="1" stopColor="#ffc41d" />
      </linearGradient>
    </defs>
    <rect x="1" y="7" width="8.5" height="10" rx="2.4" fill="#9b8cf2" opacity=".5" />
    <rect x="6" y="5" width="9.5" height="14" rx="2.8" fill="#9b8cf2" opacity=".8" />
    <rect x="12" y="3" width="11" height="18" rx="3.2" fill="url(#markGrad)" />
  </svg>
);

const MiniCard = ({ ad, store, onDownload }) => {
  const thumb = thumbOf(ad);
  const days = daysRunning(ad);
  const lists = listsForAd(store, ad.id);
  return (
    <Surface className="mini">
      <div className="mini-media" onClick={() => openInLibrary(ad)}>
        {thumb ? (
          <img src={thumb} alt="" loading="lazy" />
        ) : (
          <div className="mini-ph">{(ad.pageName || "?").slice(0, 1).toUpperCase()}</div>
        )}
        {ad.isActive === true && <span className="mini-badge mini-live">ACTIVE</span>}
        {ad.isActive === false && <span className="mini-badge mini-ended">ENDED</span>}
        <span className="mini-badge mini-fmt">{formatOf(ad).toUpperCase()}</span>
      </div>
      <div className="mini-body">
        <div
          className="mini-name"
          title="Open in the Ad Library"
          onClick={() => openInLibrary(ad)}
        >
          {ad.pageName || "Unknown page"}
        </div>
        <div className="mini-sub">
          {[days != null ? `${days}d running` : null, ad.savedBy ? `by ${ad.savedBy}` : null]
            .filter(Boolean)
            .join(" · ") || "—"}
        </div>
        {lists.length > 0 && (
          <div className="mini-chips">
            {lists.slice(0, 2).map((l) => (
              <span className="mini-chip" key={l.id}>
                <span className="dot" style={{ background: l.color }} />
                <span>{l.name}</span>
              </span>
            ))}
          </div>
        )}
        <Button size="small" className="mini-btn" onClick={() => onDownload(ad)}>
          Download
        </Button>
      </div>
    </Surface>
  );
};

const Grid = ({ ads, store, onDownload }) => (
  <div className="grid">
    {ads.map((ad) => (
      <MiniCard key={ad.id} ad={ad} store={store} onDownload={onDownload} />
    ))}
  </div>
);

const Summary = ({ store, lists, onDownload }) => {
  const saved = savedInSpace(store);
  const week = saved.filter((a) => (a.savedAt || 0) >= Date.now() - 7 * 86400000).length;
  const active = saved.filter((a) => a.isActive === true).length;
  return (
    <>
      <div className="stats">
        <Surface><Stat label="Saved" value={saved.length} /></Surface>
        <Surface><Stat label="Week" value={week} /></Surface>
        <Surface><Stat label="Lists" value={lists.length} /></Surface>
        <Surface><Stat label="Active" value={active} /></Surface>
      </div>
      <div className="section">Recently saved</div>
      {saved.length === 0 ? (
        <div className="empty">Nothing saved in this space yet.</div>
      ) : (
        <Grid ads={saved.slice(0, 4)} store={store} onDownload={onDownload} />
      )}
    </>
  );
};

const Home = ({ page, store, lists, onSaveAll, onDownload }) => {
  const savedIds = new Set(savedInSpace(store).map((a) => a.id));
  const fresh = page.ads.filter((a) => !savedIds.has(a.id));
  return (
    <>
      <Surface className="card">
        {page.onLibrary ? (
          <>
            <div className="card-title">
              {page.ads.length} ad{page.ads.length === 1 ? "" : "s"} on this page
            </div>
            <div className="card-sub">
              {page.ads.length === 0
                ? "Scroll the results to load ads."
                : fresh.length === 0
                  ? "All of them are already saved."
                  : `${fresh.length} not saved yet. Keep scrolling for more.`}
            </div>
            <Button
              variant="primary"
              className="btn-full"
              disabled={fresh.length === 0}
              onClick={() => onSaveAll(fresh)}
            >
              Save all on page
            </Button>
          </>
        ) : (
          <>
            <div className="card-title">Not on the Ad Library</div>
            <div className="card-sub">
              Your library is below. Open the Ad Library to capture new ads.
            </div>
          </>
        )}
      </Surface>
      <Summary store={store} lists={lists} onDownload={onDownload} />
    </>
  );
};

const Saved = ({ store, onDownload }) => {
  const saved = savedInSpace(store);
  return (
    <>
      <div className="section">{saved.length} saved in this space</div>
      {saved.length === 0 ? (
        <div className="empty">Save an ad and it shows up here.</div>
      ) : (
        <>
          <Grid ads={saved.slice(0, 50)} store={store} onDownload={onDownload} />
          {saved.length > 50 && (
            <div className="empty">
              Showing the 50 most recent. Open the dashboard for all.
            </div>
          )}
        </>
      )}
    </>
  );
};

const Lists = ({ lists, defaultListId, onRefresh, toast }) => (
  <>
    <div className="section">Lists in this space</div>
    <div className="empty">Pick a list to make it the default for new saves.</div>
    {lists.length === 0 && <div className="empty">No lists yet.</div>}
    {lists.map((list) => {
      const isDefault = list.id === defaultListId;
      return (
        <Surface
          key={list.id}
          className={`row${isDefault ? " is-default" : ""}`}
          interactive
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") e.currentTarget.click();
          }}
          onClick={async () => {
            await send({ type: "SET_DEFAULT_LIST", listId: isDefault ? null : list.id });
            await onRefresh();
            toast(isDefault ? "Default cleared" : `New saves go to ${list.name}`);
          }}
        >
          <span className="dot" style={{ background: list.color }} />
          <span className="row-name">{list.name}</span>
          <span className="row-count">{list.adIds.length}</span>
          {isDefault && <span className="row-tag">default</span>}
        </Surface>
      );
    })}
    <Button
      className="btn-full"
      onClick={async () => {
        const name = prompt("List name:");
        if (!name) return;
        await send({ type: "LIST_OP", op: "create", name });
        await onRefresh();
      }}
    >
      New list
    </Button>
  </>
);

const Account = ({ targets, store, page, onRefresh }) => {
  const space = targets.spaces.find((s) => s.id === targets.activeSpaceId) || null;
  return (
    <>
      <div className="section">Space</div>
      <select
        className="field"
        value={targets.activeSpaceId || ""}
        onChange={async (e) => {
          await send({ type: "SPACE_OP", op: "activate", spaceId: e.target.value });
          await onRefresh();
        }}
      >
        {targets.spaces.map((s) => (
          <option value={s.id} key={s.id}>
            {s.name}
            {s.kind === "team" ? " (team)" : ""}
          </option>
        ))}
      </select>

      {space && space.kind === "team" && (
        <Surface className="card">
          <div className="card-sub">Team join code</div>
          <div className="code">{space.code}</div>
          <div className="card-sub">
            Teammates merge your exported space file to combine lists.
          </div>
        </Surface>
      )}

      <div className="section">Appearance</div>
      <SegmentedControl
        aria-label="Appearance"
        value={targets.theme || "system"}
        items={[
          { value: "system", label: "Auto" },
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ]}
        onValueChange={async (theme) => {
          await send({ type: "SET_THEME", theme });
          await onRefresh();
        }}
      />

      <div className="section">Saved as</div>
      <div className="empty">{(store.identity && store.identity.displayName) || "Me"}</div>

      <div className="section">Detection</div>
      <Surface className="card">
        <div className="card-sub">
          {page.found} ad card{page.found === 1 ? "" : "s"} found on the page
        </div>
        <div className="card-sub">{page.decorated} have Save / Download buttons</div>
        <div className="card-sub">{page.matched} matched a captured record</div>
      </Surface>

      <div className="empty">
        Team sharing, sync and export live in the full dashboard.
      </div>
    </>
  );
};

const App = () => {
  const [targets, setTargets] = useState({
    spaces: [],
    lists: [],
    activeSpaceId: null,
    defaultListId: null,
    theme: "system",
  });
  const [store, setStore] = useState({
    ads: {},
    lists: {},
    spaces: {},
    settings: {},
    identity: {},
  });
  const [page, setPage] = useState({
    ads: [],
    onLibrary: false,
    found: 0,
    decorated: 0,
    matched: 0,
  });
  const [view, setView] = useState("home");
  const [message, setMessage] = useState("");

  const toast = useCallback((text) => {
    setMessage(text);
    setTimeout(() => setMessage(""), 2400);
  }, []);

  const refresh = useCallback(async () => {
    const [t, s, p] = await Promise.all([
      send({ type: "GET_SAVE_TARGETS" }),
      send({ type: "GET_STATE" }),
      askPage(),
    ]);
    if (t.ok)
      setTargets({
        spaces: t.spaces || [],
        lists: t.lists || [],
        activeSpaceId: t.activeSpaceId,
        defaultListId: t.defaultListId,
        theme: t.theme || "system",
      });
    if (s.ok) setStore(s);
    setPage({
      ads: p.ads || [],
      onLibrary: !!p.onLibrary,
      found: p.found || 0,
      decorated: p.decorated || 0,
      matched: p.matched || 0,
    });
  }, []);

  useEffect(() => {
    refresh();
    // The panel outlives the tab it was opened over, so it follows the user.
    const onTab = () => refresh();
    const onUpdated = (_id, info, tab) => {
      if (info.status === "complete" && tab.active) refresh();
    };
    const onMsg = (msg) => {
      if (msg && msg.type === "PAGE_ADS_CHANGED") refresh();
      return false;
    };
    const onStore = (_c, area) => {
      if (area === "local") refresh();
    };
    chrome.tabs.onActivated.addListener(onTab);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.runtime.onMessage.addListener(onMsg);
    chrome.storage.onChanged.addListener(onStore);
    return () => {
      chrome.tabs.onActivated.removeListener(onTab);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.runtime.onMessage.removeListener(onMsg);
      chrome.storage.onChanged.removeListener(onStore);
    };
  }, [refresh]);

  // Appearance drives both the document theme and the library's material tone.
  const dark =
    targets.theme === "dark" ||
    (targets.theme === "system" &&
      typeof matchMedia === "function" &&
      matchMedia("(prefers-color-scheme: dark)").matches);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);

  const lists = targets.lists.filter((l) => l.spaceId === targets.activeSpaceId);
  const space = targets.spaces.find((s) => s.id === targets.activeSpaceId) || null;

  const saveAll = async (ads) => {
    const res = await send({ type: "SAVE_ADS", ads });
    if (!res.ok) return toast("Save failed");
    toast(
      res.added === 0
        ? `Already in ${res.listName}`
        : `Saved ${res.added} to ${res.listName}`,
    );
    refresh();
  };

  const download = async (ad) => {
    if (!ad.media || ad.media.length === 0) return toast("No downloadable media on this ad");
    const res = await send({ type: "DOWNLOAD_AD", ad });
    if (!res.ok)
      return toast(
        res.reason === "unusable"
          ? "This creative has no downloadable file"
          : "Download failed",
      );
    const label =
      res.quality === "hd"
        ? " in HD"
        : res.quality === "low"
          ? " (page quality, HD not captured)"
          : "";
    toast(`Downloading ${res.count} file${res.count === 1 ? "" : "s"}${label}`);
  };

  // Personal on the left, team on the right; named generically when there is
  // one of each, by space name when there are more.
  const own = targets.spaces.filter((s) => s.kind !== "team");
  const teams = targets.spaces.filter((s) => s.kind === "team");
  const spaceItems = [
    ...own.map((s) => ({ value: s.id, label: own.length === 1 ? "Personal" : s.name })),
    ...(teams.length
      ? teams.map((s) => ({ value: s.id, label: teams.length === 1 ? "Team" : s.name }))
      : [{ value: "__none__", label: "Team" }]),
  ];

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
      <div id="app">
        <Surface material="regular" className="head">
          <Mark />
          <div>
            <div className="head-title">Ads Saver</div>
            <div className="head-sub">
              {space ? space.name + (space.kind === "team" ? " · team" : "") : "Meta Ad Library"}
            </div>
          </div>
          <SegmentedControl
            aria-label="Library"
            className="space-seg"
            value={targets.activeSpaceId || "__none__"}
            items={spaceItems}
            onValueChange={async (id) => {
              if (id === "__none__") {
                toast("Create or join a team space in the dashboard");
                send({ type: "OPEN_DASHBOARD" });
                return;
              }
              await send({ type: "SPACE_OP", op: "activate", spaceId: id });
              refresh();
            }}
          />
        </Surface>

        <SegmentedControl
          aria-label="Views"
          className="nav-seg"
          value={view}
          items={[
            { value: "home", label: "Home", icon: <Icon name={ICONS.home} /> },
            { value: "saved", label: "Saved", icon: <Icon name={ICONS.saved} /> },
            { value: "lists", label: "Lists", icon: <Icon name={ICONS.lists} /> },
            { value: "account", label: "Account", icon: <Icon name={ICONS.account} /> },
          ]}
          onValueChange={setView}
        />

        <div className="view">
          {view === "home" && (
            <Home
              page={page}
              store={store}
              lists={lists}
              onSaveAll={saveAll}
              onDownload={download}
            />
          )}
          {view === "saved" && <Saved store={store} onDownload={download} />}
          {view === "lists" && (
            <Lists
              lists={lists}
              defaultListId={targets.defaultListId}
              onRefresh={refresh}
              toast={toast}
            />
          )}
          {view === "account" && (
            <Account targets={targets} store={store} page={page} onRefresh={refresh} />
          )}
        </div>

        <footer className="foot">
          {!page.onLibrary && (
            <Button variant="primary" onClick={() => send({ type: "OPEN_LIBRARY" })}>
              Go to Ad Library
            </Button>
          )}
          <Button onClick={() => send({ type: "OPEN_DASHBOARD" })}>
            Open full dashboard
          </Button>
        </footer>

        {message && (
          <Surface material="frosted" className="toast show" role="status" aria-live="polite">
            {message}
          </Surface>
        )}
      </div>
    </GlassSystemProvider>
  );
};

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
