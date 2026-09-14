/**
 * Running a discovery sweep.
 *
 * Each search term is opened as a background Ad Library tab. The interceptor is
 * already a document_start MAIN-world content script on that URL, so results
 * are captured before Facebook's own code runs and the first page is read
 * straight out of the server-rendered JSON with no extra request at all. What
 * this file adds is the return path, which the panel's own askPage() cannot
 * provide because it only ever talks to the active tab.
 *
 * Two things are deliberate and worth not undoing.
 *
 * First, the requests go out on the user's own logged-in Facebook session from
 * their own browser. That is what makes this free, and it is also the whole
 * risk: a blocked scraper costs a run, a blocked user costs them their personal
 * account. So terms are capped, a real pause sits between them, and nothing
 * here loops on its own.
 *
 * Second, this only ever reads the first page. Pagination in a hidden tab means
 * driving scroll against a React app in a document Chrome throttles on purpose,
 * and the honest answer is that one page per term is enough to cluster on. If
 * it stops being enough, that is the point to reconsider a paid scraper, not
 * the point to write a scroll driver.
 */
import { searchUrl } from "./terms.js";

export const MAX_TERMS = 8;

const DEFAULTS = {
  country: "ALL",
  activeOnly: true,
  // How long a quiet tab has to stay quiet before it is considered finished.
  stallMs: 2500,
  // The hard ceiling per term, because nothing announces "this page is done".
  maxMs: 20000,
  pollMs: 600,
  // Between terms. Eight searches back to back with no gap is not what a person
  // browsing looks like.
  dwellMs: 4000,
};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const askTab = (tabId, msg) =>
  new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, msg, (res) => {
        // A tab whose content script has not run yet answers with a lastError
        // rather than a reply. That is "not ready", not "nothing here".
        if (chrome.runtime.lastError) resolve(null);
        else resolve(res || null);
      });
    } catch (err) {
      resolve(null);
    }
  });

/**
 * Watch one tab until its capture count stops growing.
 *
 * Returns what it saw plus, importantly, whether the interceptor posted
 * anything at all. Zero ads because the search matched nothing and zero ads
 * because the parser broke look identical from a count, and they need opposite
 * responses.
 */
const collect = async (tabId, opts, onProgress, term) => {
  const started = Date.now();
  let best = null;
  let lastCount = -1;
  let lastChange = Date.now();

  for (;;) {
    await delay(opts.pollMs);
    const res = await askTab(tabId, { type: "GET_CAPTURED_ADS" });
    const elapsed = Date.now() - started;

    if (res && res.ok) {
      best = res;
      if (res.captured !== lastCount) {
        lastCount = res.captured;
        lastChange = Date.now();
        if (onProgress) onProgress({ term, phase: "capturing", found: res.captured });
      } else if (res.scanned && Date.now() - lastChange >= opts.stallMs) {
        return { ...res, elapsed, reason: "settled" };
      }
    }

    if (elapsed >= opts.maxMs)
      return best
        ? { ...best, elapsed, reason: "timeout" }
        : { ok: false, ads: [], captured: 0, scanned: false, elapsed, reason: "no_response" };
  }
};

/**
 * Sweep a list of terms. Returns [{ term, ads, captured, scanned, reason }],
 * one entry per term, in the order given.
 *
 * `onProgress` is called for every state change so the UI can show what is
 * happening rather than a spinner over a black box.
 */
export const sweep = async (terms, options = {}) => {
  const opts = { ...DEFAULTS, ...options };
  const onProgress = options.onProgress || null;
  const chosen = (terms || []).slice(0, MAX_TERMS);
  const hits = [];

  for (let i = 0; i < chosen.length; i++) {
    const term = chosen[i];
    if (onProgress) onProgress({ term, phase: "opening", index: i, total: chosen.length });

    let tab = null;
    try {
      tab = await chrome.tabs.create({
        url: searchUrl(term, { country: opts.country, activeOnly: opts.activeOnly }),
        active: false,
      });
      const res = await collect(tab.id, opts, onProgress, term);
      hits.push({
        term,
        ads: (res && res.ads) || [],
        captured: (res && res.captured) || 0,
        // False here means the interceptor never posted. Treat the zero as a
        // failure to read the page, not as an answer about the market.
        scanned: !!(res && res.scanned),
        reason: (res && res.reason) || "unknown",
      });
    } catch (err) {
      hits.push({ term, ads: [], captured: 0, scanned: false, reason: String(err?.message || err) });
    } finally {
      if (tab && tab.id != null) {
        try {
          await chrome.tabs.remove(tab.id);
        } catch (err) {
          /* the user may have closed it themselves */
        }
      }
    }

    if (onProgress)
      onProgress({ term, phase: "done", index: i, total: chosen.length, found: hits[i].captured });
    if (i < chosen.length - 1) await delay(opts.dwellMs);
  }

  return hits;
};

/** A sweep that read nothing anywhere is a broken read, not an empty market. */
export const sweepFailed = (hits) => hits.length > 0 && hits.every((h) => !h.scanned);
