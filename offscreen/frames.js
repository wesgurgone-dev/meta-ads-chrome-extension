/**
 * Offscreen document: turns a saved ad's video into still frames for scoring.
 *
 * Why this file exists at all: MV3 service workers have no DOM, so there is no
 * <video> and no <canvas> to decode with. An offscreen document is the only
 * context that has both without showing the user a tab.
 *
 * Two constraints shape everything below.
 *
 *   1. The video is fetched here, as bytes, and played from a blob: URL. A
 *      cross-origin fbcdn URL assigned straight to a <video> is a no-CORS media
 *      load, which taints the canvas and makes toDataURL() throw. host
 *      permissions cover fetch(), not media element loads, so fetching first is
 *      what makes the canvas readable. A blob: URL is same-origin.
 *
 *   2. Seeking is driven off the 'seeked' event, never rAF. A document that is
 *      never painted is not guaranteed to run animation frames at all.
 *
 * Results are written to chrome.storage.local directly rather than returned, so
 * a service worker dying mid-batch loses nothing already captured.
 */

const FRAME_LONG_EDGE = 1024;
const FRAME_QUALITY = 0.72;
const MAX_VIDEO_BYTES = 48 * 1024 * 1024;
const SEEK_TIMEOUT_MS = 8000;
const LOAD_TIMEOUT_MS = 25000;
const FRAMES_VERSION = 1;

/**
 * Where to sample. The hook is decided in the first three seconds, so the front
 * is dense; two late frames are enough to see how it resolves.
 */
const sampleTimes = (duration) => {
  const early = [0, 0.5, 1, 1.5, 2.5, 4];
  const late = [duration * 0.6, duration * 0.9];
  const seen = new Set();
  const out = [];
  for (const t of [...early, ...late]) {
    if (!Number.isFinite(t) || t < 0 || t > duration) continue;
    // Two requested times landing on the same tenth of a second would spend an
    // input image on a duplicate frame.
    const key = Math.round(t * 10);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(Math.min(t, Math.max(0, duration - 0.05)));
  }
  return out.sort((a, b) => a - b);
};

const once = (target, event, timeoutMs, label) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${label} timed out`));
    }, timeoutMs);
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error(`${label} failed`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(event, onOk);
      target.removeEventListener("error", onErr);
    };
    target.addEventListener(event, onOk, { once: true });
    target.addEventListener("error", onErr, { once: true });
  });

const drawFrame = (video, canvas) => {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  const scale = Math.min(1, FRAME_LONG_EDGE / Math.max(w, h));
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", FRAME_QUALITY);
};

/**
 * Extract from one ad. Returns the record it stored, or throws with a reason
 * the worker can put on the ad so a silent zero is never mistaken for "this ad
 * scored badly".
 */
const extract = async ({ adId, url, source }) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const blob = await res.blob();
  if (!blob.size) throw new Error("empty video");
  if (blob.size > MAX_VIDEO_BYTES) throw new Error("video too large");

  const objectUrl = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  const canvas = document.createElement("canvas");
  const frames = [];
  let duration = 0;

  try {
    video.src = objectUrl;
    await once(video, "loadedmetadata", LOAD_TIMEOUT_MS, "metadata");
    duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (!duration) throw new Error("no duration");

    for (const t of sampleTimes(duration)) {
      video.currentTime = t;
      try {
        await once(video, "seeked", SEEK_TIMEOUT_MS, "seek");
      } catch (err) {
        // One unseekable position is not a reason to lose the frames already
        // captured; the record carries the count actually taken.
        continue;
      }
      const dataUrl = drawFrame(video, canvas);
      if (dataUrl) frames.push({ t: Number(t.toFixed(2)), dataUrl });
    }
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(objectUrl);
  }

  if (!frames.length) throw new Error("no frames captured");

  const record = {
    v: FRAMES_VERSION,
    adId,
    source: source || "unknown",
    duration,
    w: canvas.width,
    h: canvas.height,
    capturedAt: Date.now(),
    frames,
  };
  await chrome.storage.local.set({ [`frames_${adId}`]: record });
  return record;
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "frames-offscreen") return false;
  if (msg.type !== "EXTRACT_FRAMES") return false;
  extract(msg)
    .then((record) =>
      sendResponse({ ok: true, adId: msg.adId, count: record.frames.length }),
    )
    .catch((err) =>
      sendResponse({ ok: false, adId: msg.adId, error: String(err.message || err) }),
    );
  return true;
});
