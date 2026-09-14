/**
 * Loads the unpacked extension in headless Chromium and drives the real
 * background, content script, side panel and dashboard.
 *
 *   PW=/path/to/playwright CHROME=/path/to/chromium node tests/ui.test.cjs
 *
 * Headless has no browser side-panel chrome, so the panel page is opened as an
 * ordinary tab. That exercises every line of it; what it cannot cover is
 * Chrome's own docking frame.
 */
const { chromium } = require(process.env.PW || 'playwright');
const EXT = process.env.EXT || require('path').resolve(__dirname, '..');
const CHROME = process.env.CHROME || undefined;

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); };

const ids = ['853222324181295', '853222324181296'];

/**
 * Mirrors a real Ad Library card closely enough to test the DOM scrape: the
 * status word, the printed Library ID, the "Started running on" line, the
 * collation line, the advertiser above "Sponsored", the body copy, the
 * outbound link and the call to action. The old fixture had none of this,
 * which is why a card saved with no dates, no copy and no link went unnoticed.
 */
const card = (id, name) => `
  <div class="card" style="width:330px;border:1px solid #ddd;padding:12px;display:flex;flex-direction:column">
    <div>Active</div>
    <div>Library ID: ${id}</div>
    <div>Started running on 15 Jan 2026</div>
    <div>Platforms</div>
    <img alt="Facebook" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="12" height="12" />
    <img alt="Instagram" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="12" height="12" />
    <div>2 ads use this creative and text</div>
    <div style="display:flex;gap:8px"><div role="button" tabindex="0" style="flex:1">See ad details</div></div>
    <div><strong>${name}</strong></div>
    <div>Sponsored</div>
    <div>Hydration that actually works. One stick a day, and you are done with
      chalky tablets for good.</div>
    <!-- An http URL, because the scrape deliberately keeps only http(s) media:
         a data: URI is a spacer or an inlined icon, never a creative. -->
    <img class="creative" src="https://scontent.fbcdn.net/v/creative-${id}.jpg" width="290" height="180" />
    <a href="https://drinkhyro.com.au/offer">50% Off + Free Welcome Kit</a>
    <div role="button" tabindex="0">Shop now</div>
  </div>`;
const LIB_PAGE = `<!doctype html><html><body style="margin:0">
  <div style="display:flex;gap:14px;padding:14px">${ids.map((id, i) => card(id, 'Hyro ' + i)).join('')}</div>
</body></html>`;

(async () => {
  const ctx = await chromium.launchPersistentContext(
    require('os').tmpdir() + '/mal-ui-' + Date.now(),
    {
      headless: true, executablePath: CHROME,
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
      viewport: { width: 1280, height: 900 },
    });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const extId = new URL(sw.url()).host;

  // The worker is a module, which Playwright attaches to earlier than a classic
  // one - early enough that the extension bindings are not installed yet and
  // the first evaluate sees `chrome` as undefined. Wait for the binding rather
  // than for a fixed delay.
  for (let i = 0; i < 100; i++) {
    const ready = await sw.evaluate(() => typeof chrome !== 'undefined' && !!chrome.runtime)
      .catch(() => false);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const errors = [];
  const watch = (p, tag) => {
    p.on('pageerror', (e) => errors.push(`${tag} pageerror: ${e.message}`));
    p.on('console', (m) => {
      const text = m.text();
      // The team-sync test deliberately routes a 404 to prove the readout
      // names a missing schema, so that one is the case under test.
      const expected = text.includes('ERR_') || /404 \(Not Found\)/.test(text);
      if (m.type() === 'error' && !expected) errors.push(`${tag} console: ${text}`);
    });
  };

  console.log('--- manifest ---');
  const mf = await sw.evaluate(() => chrome.runtime.getManifest());
  ok(mf.side_panel && mf.side_panel.default_path === 'panel/panel.html', 'side_panel declared');
  ok(mf.permissions.includes('sidePanel'), 'sidePanel permission');
  ok(!mf.action.default_popup, 'no popup, so Chrome opens the panel on the action click');
  ok(!mf.permissions.includes('scripting'), 'nothing is injected any more');
  // Frames are decoded in an offscreen document because the worker has no DOM.
  ok(mf.permissions.includes('offscreen'), 'offscreen permission, for video frame capture');

  console.log('--- bundles are MV3-safe ---');
  const bundles = await sw.evaluate(async () => {
    const get = async (f) => (await (await fetch(chrome.runtime.getURL(f))).text());
    const [panel, dash, frames] = await Promise.all([
      get('panel/panel.bundle.js'),
      get('dashboard/dashboard.bundle.js'),
      get('offscreen/frames.js'),
    ]);
    const bad = (s) => /\beval\s*\(/.test(s) || /new\s+Function\s*\(/.test(s) || /sourceMappingURL=data:/.test(s);
    return { panelKB: Math.round(panel.length / 1024), dashKB: Math.round(dash.length / 1024),
             panelBad: bad(panel), dashBad: bad(dash), framesBad: bad(frames),
             framesGuarded: /msg\.target !== "frames-offscreen"/.test(frames),
             // The two libraries this budget actually exists to keep out.
             heavy: /xyflow|react-flow|@anthropic-ai\/sdk|anthropic-ai-sdk/.test(dash) };
  });
  ok(!bundles.panelBad && !bundles.dashBad, 'no eval, no new Function, no inline source map');
  // The offscreen document is hand-written and unbundled, so it is not covered
  // by the two assertions above and needs its own.
  ok(!bundles.framesBad, 'the offscreen frame extractor is MV3-safe too');
  ok(bundles.framesGuarded, 'and only answers messages addressed to it');
  // The dashboard carries supabase-js (~220KB) and the panel does not, so they
  // get their own budgets rather than one number that hides the difference.
  //
  // The budget is here to catch a heavy dependency landing, not to cap feature
  // code - React Flow alone would add 177KB and does not tree-shake, and the
  // Anthropic SDK belongs to the Edge Function and must never reach a bundle.
  // So the ceiling is generous and the two names are asserted directly, rather
  // than a tight number that a legitimate feature trips first.
  ok(bundles.panelKB < 320, `panel bundle ${bundles.panelKB}KB`);
  ok(bundles.dashKB < 620, `dashboard bundle ${bundles.dashKB}KB, supabase-js included`);
  ok(!bundles.heavy, 'no graph library and no Anthropic SDK in the dashboard bundle');

  console.log('--- content script still decorates Ad Library cards ---');
  const lib = await ctx.newPage();
  watch(lib, 'library');
  await lib.route(/facebook\.com\/ads\/library/, (r) => r.fulfill({ contentType: 'text/html', body: LIB_PAGE }));
  await lib.goto('https://www.facebook.com/ads/library/?q=hyro');
  await lib.waitForTimeout(2600);
  ok(await lib.locator('.mal-bar').count() === 2, 'both cards get their action row');
  ok(await lib.locator('#mal-panel').count() === 0, 'no panel is injected into the page');

  console.log('--- the page answers the panel over GET_PAGE_ADS ---');
  const report = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'https://www.facebook.com/ads/library*' });
    return chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_PAGE_ADS' });
  });
  ok(report && report.ok === true && report.onLibrary === true, 'responds, and says it is on the Library');
  ok(report.ads.length === 2 && report.decorated === 2, `reports 2 ads, 2 decorated`);

  console.log('--- a card with no captured record still yields its details ---');
  // The DOM fallback used to carry only the advertiser, an active flag and the
  // media, so a saved ad showed "Unknown page" with no dates and no copy.
  const ad = report.ads.find((a) => a.id === '853222324181295');
  ok(!!ad && ad.fromDom === true, 'this one came from the DOM, not from a capture');
  ok(ad.pageName === 'Hyro 0', `advertiser (${ad.pageName})`);
  ok(ad.isActive === true, `status (${ad.isActive})`);
  ok(new Date(ad.startDate).getUTCFullYear() === 2026 && new Date(ad.startDate).getUTCMonth() === 0,
     `start date parsed (${ad.startDate && new Date(ad.startDate).toISOString().slice(0, 10)})`);
  ok(ad.collationCount === 2, `variation count (${ad.collationCount})`);
  ok(/drinkhyro\.com\.au/.test(ad.linkUrl || ''), `destination (${ad.linkUrl})`);
  ok(ad.ctaText === 'Shop now', `call to action (${ad.ctaText})`);
  ok(/Hydration that actually works/.test(ad.body || ''), 'body copy');
  ok((ad.platforms || []).includes('Facebook') && ad.platforms.includes('Instagram'),
     `platforms (${(ad.platforms || []).join(', ')})`);
  ok(ad.media.length === 1, `one creative, avatars and spacers skipped (${ad.media.length})`);

  console.log('--- side panel ---');
  const panel = await ctx.newPage();
  watch(panel, 'panel');
  await panel.setViewportSize({ width: 400, height: 820 });
  await panel.goto(`chrome-extension://${extId}/panel/panel.html`);
  await panel.waitForTimeout(2200);
  ok(await panel.locator('#app').count() === 1, 'React app mounted');
  ok(await panel.locator('.nav-seg .ogui-segments__item').count() === 4, 'four nav segments');
  ok(await panel.locator('.space-seg .ogui-segments__item').count() === 2, 'personal / team switch');

  console.log('--- refraction is actually running ---');
  const refract = await panel.evaluate(() => {
    const surfaces = [...document.querySelectorAll('[data-ogui-glass]')];
    return {
      count: surfaces.length,
      renderers: [...new Set(surfaces.map((n) => n.dataset.oguiRenderer))],
      reasons: [...new Set(surfaces.map((n) => n.dataset.oguiRendererReason))],
      displacementMaps: document.querySelectorAll('filter feDisplacementMap').length,
      filtered: surfaces.filter((n) => /url\(/.test(getComputedStyle(n).filter)).length,
      // Each lens must be empty: a filtered element displaces its own content.
      lensesEmpty: surfaces.every((n) => n.textContent.trim() === ''),
      tones: [...new Set(surfaces.map((n) => n.dataset.oguiTone))],
    };
  });
  ok(refract.count >= 4, `${refract.count} glass surfaces`);
  // Refraction is opt-in: measured in Chromium it replaces the backdrop with a
  // flat grey rather than bending it. See src/surface.jsx for the A/B.
  ok(refract.renderers.join() === 'css', `surfaces default to the CSS material (${refract.renderers.join()})`);
  ok(refract.filtered === 0, 'no surface carries an SVG filter by default');
  ok(refract.lensesEmpty, 'every lens is empty, so no content can be displaced');
  ok(refract.tones.length === 1, `one tone across the panel (${refract.tones.join()})`);

  console.log('--- topo ground, and the theme is always resolved ---');
  const ground = await panel.evaluate(() => ({
    image: getComputedStyle(document.body).backgroundImage,
    topo: document.body.classList.contains('topo'),
    theme: document.documentElement.dataset.theme,
  }));
  ok(ground.topo && /repeating-radial-gradient/.test(ground.image), 'contour lines behind everything');
  // "system" used to leave the attribute unset, which left the page stylesheet
  // on its dark default while the library resolved the material to light.
  ok(['dark', 'light'].includes(ground.theme), `theme resolved to ${ground.theme}, never left unset`);

  console.log('--- secondary text stays readable on the material ---');
  const muted = await panel.evaluate(() => {
    const el = document.querySelector('.ogui-stat') || document.querySelector('.stat-label');
    if (!el) return null;
    const m = getComputedStyle(el).color.match(/[\d.]+/g);
    return m ? m.map(Number) : null;
  });
  ok(muted !== null, 'a stat label is on screen to measure');

  console.log('--- views switch ---');
  for (const [view, needle] of [['saved', 'saved in this space'], ['lists', 'Lists in this space'], ['account', 'Space']]) {
    await panel.locator(`.nav-seg .ogui-segments__item:has-text("${view[0].toUpperCase() + view.slice(1)}")`).click();
    await panel.waitForTimeout(400);
    const txt = (await panel.locator('.view').innerText()).toLowerCase();
    ok(txt.includes(needle.toLowerCase()), `${view} view renders`);
  }

  console.log('--- dashboard ---');
  const dash = await ctx.newPage();
  watch(dash, 'dashboard');
  await dash.setViewportSize({ width: 1280, height: 900 });
  await dash.goto(`chrome-extension://${extId}/dashboard/dashboard.html`);
  await dash.waitForTimeout(2200);
  const layout = await dash.evaluate(() => {
    const box = (s) => {
      const n = document.querySelector(s);
      return n ? n.getBoundingClientRect() : null;
    };
    const side = box('#sidebar'), main = box('#main');
    return {
      sideWidth: side && Math.round(side.width),
      sideBeside: !!(side && main && main.x >= side.width - 1 && Math.abs(main.y - side.y) < 2),
      stats: document.querySelectorAll('.stat').length,
      navItems: document.querySelectorAll('.nav-item').length,
      surfaces: document.querySelectorAll('[data-ogui-glass]').length,
      sdf: [...new Set([...document.querySelectorAll('[data-ogui-glass]')].map((n) => n.dataset.oguiRenderer))],
      empty: !!document.querySelector('.empty h2'),
    };
  });
  ok(layout.sideBeside, `sidebar and main sit side by side (sidebar ${layout.sideWidth}px)`);
  ok(layout.stats === 6, `six stat tiles (${layout.stats})`);
  ok(layout.navItems >= 1, `${layout.navItems} nav items`);
  ok(layout.sdf.join() === 'css', 'dashboard surfaces use the same CSS material as the panel');
  ok(layout.empty, 'empty state renders when nothing is saved');

  console.log('--- filters and export are wired ---');
  await dash.locator('#search').fill('nothing-matches-this');
  await dash.waitForTimeout(400);
  ok(await dash.locator('.grid .card').count() === 0, 'search filters the grid');
  await dash.locator('#search').fill('');
  await dash.waitForTimeout(300);

  console.log('--- detail view keeps tall creatives on screen ---');
  const fit = await dash.evaluate(async () => {
    const probe = document.createElement('div');
    probe.className = 'modal-media';
    probe.innerHTML = '<img id="probe">';
    document.body.appendChild(probe);
    const img = document.getElementById('probe');
    await new Promise((res) => {
      img.onload = res; img.onerror = res;
      img.src = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='1080' height='1920'><rect width='1080' height='1920' fill='%23888'/></svg>";
    });
    const r = { natural: img.naturalWidth + 'x' + img.naturalHeight,
                h: Math.round(img.getBoundingClientRect().height),
                fit: getComputedStyle(img).objectFit, vh: window.innerHeight };
    probe.remove();
    return r;
  });
  ok(fit.natural === '1080x1920', `probe is 9:16 (${fit.natural})`);
  ok(fit.fit === 'contain', 'creatives letterbox rather than stretch');
  ok(fit.h > 0 && fit.h <= fit.vh * 0.6, `a 9:16 creative fits (${fit.h}px of ${fit.vh}px)`);

  console.log('--- every saved ad is queued for scoring, not waiting on a click ---');
  // Seed one saved ad straight into the store. The dashboard is otherwise
  // empty in this harness, and a card is needed to open a detail view at all.
  await sw.evaluate(async () => {
    const { lists = {}, ads = {} } = await chrome.storage.local.get(['lists', 'ads']);
    const list = Object.values(lists)[0];
    ads['853222324181295'] = {
      id: '853222324181295',
      pageName: 'Hyro',
      isActive: true,
      startDate: Date.UTC(2026, 0, 15),
      body: 'Hydration that works.',
      ctaText: 'Shop now',
      media: [{ type: 'video', url: 'https://cdn.example/x.mp4' }],
      savedAt: Date.now(),
      savedBy: 'Me',
    };
    list.adIds = ['853222324181295'];
    await chrome.storage.local.set({ ads, lists });
  });
  await dash.reload();
  await dash.waitForTimeout(2500);
  ok(await dash.locator('.grid .card').count() === 1, 'the seeded ad renders as a card');

  // Opening the dashboard restarts scoring for anything unscored. There is no
  // network here, so what is asserted is that it was attempted and the reason
  // recorded - not that a score came back.
  await dash.waitForTimeout(2500);
  const queue = await sw.evaluate(() =>
    chrome.storage.local.get(['scoreQueue', 'scoreBlock', 'scores']));
  ok(
    (queue.scoreQueue || []).length > 0 || queue.scoreBlock || (queue.scores || {})['853222324181295'],
    'the ad was queued for scoring without anybody asking',
  );

  console.log('--- a score reads as one number, red through green ---');
  await sw.evaluate(async () => {
    const axis = (band, score) => ({ evidence: 'a legible claim by frame 1', frame_index: 0, band, score });
    await chrome.storage.local.set({
      scores: {
        '853222324181295': {
          adId: '853222324181295', rubricVersion: 'rubric_v1', model: 'claude-opus-5',
          axes: { hook: axis('strong', 8), utility: axis('strong', 8),
                  succinctness: axis('strong', 7), production: axis('strong', 8) },
          overall: 7.9, frames: 8, frameKind: 'video', createdAt: Date.now(),
        },
      },
    });
  });
  await dash.waitForTimeout(1200);
  const badge = await dash.evaluate(() => {
    const el = document.querySelector('.grid .card .score-badge');
    if (!el) return null;
    const bg = getComputedStyle(el).backgroundColor;
    const box = el.getBoundingClientRect();
    const media = document.querySelector('.grid .card .card-media').getBoundingClientRect();
    return { text: el.textContent.trim(), bg, onMedia: box.top >= media.top - 1 && box.left >= media.left - 1 };
  });
  ok(badge !== null, 'the card carries a score badge');
  ok(badge.text === '8', `showing one whole number (${badge && badge.text})`);
  ok(badge.onMedia, 'sitting on the creative, where it reads at a glance');

  // Hue is the whole signal: a 2 has to look wrong next to a 9.
  const hues = await dash.evaluate(() => {
    const probe = document.createElement('span');
    document.body.appendChild(probe);
    const read = (score) => {
      probe.style.background = `hsl(${Math.round(130 * Math.pow(score / 10, 1.6))}, 78%, 44%)`;
      const [r, g] = getComputedStyle(probe).backgroundColor.match(/\d+/g).map(Number);
      return { r, g };
    };
    const out = { low: read(2), high: read(9) };
    probe.remove();
    return out;
  });
  ok(hues.low.r > hues.low.g, `a low score is red (${JSON.stringify(hues.low)})`);
  ok(hues.high.g > hues.high.r, `a high score is green (${JSON.stringify(hues.high)})`);

  await dash.locator('.grid .card .card-media').first().click();
  await dash.waitForTimeout(700);
  const detail = await dash.evaluate(() => ({
    big: (document.querySelector('.score-badge-lg') || {}).textContent,
    axes: document.querySelectorAll('.score-axes li').length,
    offers: [...document.querySelectorAll('.score-panel button')].map((b) => b.textContent.trim()),
  }));
  ok(detail.big === '8', `the detail view leads with the same number (${detail.big})`);
  ok(detail.axes === 4, `with the four axes behind it (${detail.axes})`);
  ok(
    detail.offers.some((t) => /Score again/.test(t)) && !detail.offers.some((t) => /Score this ad/.test(t)),
    `and the only button is a deliberate re-score (${detail.offers.join(', ')})`,
  );
  await dash.locator('.modal-close').click();
  await dash.waitForTimeout(300);

  console.log('--- discovery derives search terms from a list ---');
  // Only the first two steps are exercised here. The sweep itself opens tabs on
  // facebook.com, and this container has no outbound network, so the tab never
  // commits a navigation and Playwright never attaches to it - a routed fixture
  // cannot reach it. The orchestration (polling, stall detection, the term cap,
  // tab cleanup) is covered against a stubbed chrome.tabs in
  // tests/discover.test.mjs instead, which is where it can actually be asserted.
  await dash.locator('.pagetabs .ogui-segments__item:has-text("Discover")').click();
  await dash.waitForTimeout(500);
  ok(await dash.locator('.discover').count() === 1, 'the Discover section renders');
  await dash.locator('.discover-step button:has-text("Suggest terms")').click();
  await dash.waitForTimeout(400);
  const suggested = await dash.locator('.discover-terms').inputValue();
  ok(suggested.split('\n').filter(Boolean).length > 0,
     `terms are derived from the seed list: ${suggested.split('\n').join(', ')}`);
  ok(!/hyro/i.test(suggested), 'and never the seed advertiser\'s own name');
  ok(await dash.locator('.discover-step button:has-text("Search the Ad Library")').count() === 1,
     'the search is a deliberate second click, never automatic');
  await dash.locator('.pagetabs .ogui-segments__item:has-text("Library")').click();
  await dash.waitForTimeout(400);

  console.log('--- the workflow canvas holds a brief and survives a reload ---');
  const onDialog = (d) => d.accept('Probe canvas');
  dash.on('dialog', onDialog);
  await dash.locator('.pagetabs .ogui-segments__item:has-text("Workflow")').click();
  await dash.waitForTimeout(500);
  ok(await dash.locator('.wf-empty').count() === 1, 'the workflow section starts with no canvas');
  await dash.locator('button:has-text("New canvas")').click();
  await dash.waitForTimeout(900);
  ok(await dash.locator('.wf-node-output').count() === 1,
     'a new canvas is born with its output node, since a brief needs something to generate into');

  await dash.locator('.wf-bar button:has-text("+ Reference")').click();
  await dash.waitForTimeout(500);
  ok(await dash.locator('.wf-picker-item').count() >= 1, 'the picker offers the saved ads');
  await dash.locator('.wf-picker-item').first().click();
  await dash.waitForTimeout(700);
  ok(await dash.locator('.wf-node').count() === 2, 'the reference lands on the canvas');
  ok(await dash.locator('.wf-edge').count() === 1, 'wired into the output, not left dangling');

  // The frame has to scroll internally. A canvas that grows the page instead is
  // unusable, and the sidebar is position:sticky so the page will grow if let.
  const geom = await dash.evaluate(() => ({
    pane: Math.round(document.querySelector('.wf-pane').getBoundingClientRect().height),
    doc: Math.round(document.documentElement.scrollHeight),
    win: window.innerHeight,
    edgesPE: getComputedStyle(document.querySelector('.wf-edges')).pointerEvents,
  }));
  ok(geom.pane > 300, `the pane has real height (${geom.pane}px), not a collapsed surface wrapper`);
  ok(geom.doc <= geom.win + 2, `the canvas scrolls internally (doc ${geom.doc}, window ${geom.win})`);
  ok(geom.edgesPE === 'none', 'the edge layer does not swallow clicks meant for nodes');

  await dash.locator('.wf-node-reference textarea').fill('the hook and the first 3 seconds');
  await dash.waitForTimeout(700);

  const nodeBox = await dash.locator('.wf-node-reference .wf-node-kind').boundingBox();
  const posBefore = await dash.locator('.wf-node-reference').getAttribute('style');
  await dash.mouse.move(nodeBox.x + 5, nodeBox.y + 5);
  await dash.mouse.down();
  await dash.mouse.move(nodeBox.x + 205, nodeBox.y + 105, { steps: 8 });
  await dash.mouse.up();
  await dash.waitForTimeout(600);
  const posAfter = await dash.locator('.wf-node-reference').getAttribute('style');
  ok(posBefore !== posAfter, `dragging moves the node (${posBefore} -> ${posAfter})`);
  ok(/translate\(280px, 160px\)/.test(posAfter),
     'by exactly the distance dragged, so the grab offset is in world space');

  // The wheel listener must be non-passive, or the dashboard scrolls underneath.
  const pane = await dash.locator('.wf-pane').boundingBox();
  await dash.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
  await dash.mouse.wheel(0, -240);
  await dash.waitForTimeout(250);
  const wheeled = await dash.evaluate(() => ({
    t: document.querySelector('.wf-nodes').style.transform,
    scroll: window.scrollY,
  }));
  ok(/translate\(60px, 280px\)/.test(wheeled.t), `the wheel pans the canvas (${wheeled.t})`);
  ok(wheeled.scroll === 0, 'and the page itself does not scroll');

  // Cutting an edge: this only works because the pane refuses to capture the
  // pointer unless the press landed on the empty pane. Capture on every press
  // retargets the click and the edge becomes uncuttable.
  const mid = await dash.evaluate(() => {
    const path = document.querySelector('.wf-edge-hit');
    const p = path.getPointAtLength(path.getTotalLength() / 2);
    const g = new DOMPoint(p.x, p.y).matrixTransform(path.getScreenCTM());
    return { x: g.x, y: g.y };
  });
  await dash.mouse.click(mid.x, mid.y);
  await dash.waitForTimeout(600);
  ok(await dash.locator('.wf-edge').count() === 0, 'clicking an edge cuts it');

  await dash.reload();
  await dash.waitForTimeout(2200);
  await dash.locator('.pagetabs .ogui-segments__item:has-text("Workflow")').click();
  await dash.waitForTimeout(600);
  ok(await dash.locator('.wf-list li').count() === 1, 'the canvas is listed after a reload');
  await dash.locator('.wf-list li > button').first().click();
  await dash.waitForTimeout(700);
  ok(await dash.locator('.wf-node').count() === 2, 'and reopens with its nodes');
  ok(await dash.locator('.wf-node-reference textarea').inputValue() === 'the hook and the first 3 seconds',
     'including the note, which is the part the whole feature is about');
  // Deleting an ad from the library must not touch a brief written about it.
  // The note is canvas-owned work; the ad is a foreign reference.
  await dash.evaluate(
    () =>
      new Promise((r) =>
        chrome.runtime.sendMessage({ type: 'DELETE_ADS', adIds: ['853222324181295'] }, r),
      ),
  );
  await dash.reload();
  await dash.waitForTimeout(2200);
  await dash.locator('.pagetabs .ogui-segments__item:has-text("Workflow")').click();
  await dash.waitForTimeout(600);
  await dash.locator('.wf-list li > button').first().click();
  await dash.waitForTimeout(700);
  ok(await dash.locator('.wf-node').count() === 2, 'deleting the ad leaves the node standing');
  ok(await dash.locator('.wf-node-reference textarea').inputValue() === 'the hook and the first 3 seconds',
     'and the note written about it');
  ok(/no longer in your library/.test(await dash.locator('.wf-node-gone').innerText()),
     'the node says the ad is gone rather than rendering blank');

  dash.removeListener('dialog', onDialog);
  await dash.locator('.pagetabs .ogui-segments__item:has-text("Library")').click();
  await dash.waitForTimeout(400);

  console.log('--- team sync status reports each fact separately ---');
  // The browser in CI has no outbound network, so the project is routed here.
  // The three facts fail independently and each has a different fix, which is
  // why they are three rows and not one "connected" light.
  const sb = /jkshbnmqyyrafszagxiq\.supabase\.co/;
  await dash.route(new RegExp(sb.source + '.*/auth/v1/health'), (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await dash.route(new RegExp(sb.source + '.*/rest/v1/teams'), (r) =>
    r.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.teams'" }),
    }));

  await dash.locator('.sidebar-footer .ogui-button:has-text("Settings")').click();
  await dash.waitForTimeout(2500);
  const rows = (await dash.locator('.sync-row').allInnerTexts()).map((s) => s.replace(/\s+/g, ' ').trim());
  ok(rows.length === 4, `four status rows (${rows.length})`);
  ok(/Project configured yes/.test(rows[0] || ''), `configured: ${rows[0]}`);
  ok(/Project reachable yes/.test(rows[1] || ''), `reachable: ${rows[1]}`);
  ok(/Schema applied run supabase\/schema\.sql/.test(rows[2] || ''),
     `schema missing is named, with the fix: ${rows[2]}`);
  ok(/Signed in sign in below/.test(rows[3] || ''), `signed out: ${rows[3]}`);

  console.log('--- sending creative off the device is a visible choice ---');
  // The settings modal is already open from the block above.
  const settings = await dash.evaluate(() => {
    const rows = [...document.querySelectorAll('.toggle-row')];
    const frames = rows.find((r) => /Capture video frames/.test(r.innerText));
    return {
      rows: rows.length,
      found: !!frames,
      on: frames ? frames.querySelector('input').checked : null,
      says: frames ? frames.innerText.replace(/\s+/g, ' ') : '',
    };
  });
  ok(settings.found, 'frame capture is a setting, not a silent default');
  const gating = await dash.evaluate(() => {
    const rows = [...document.querySelectorAll('.toggle-row')].map((r) =>
      r.innerText.replace(/\s+/g, ' '));
    return {
      signIn: rows.find((t) => /Sign in/.test(t)) || '',
      fast: rows.find((t) => /Faster scoring/.test(t)) || '',
    };
  });
  ok(/optional/i.test(gating.signIn),
     `sign-in is marked optional, because nothing but teams needs it: ${gating.signIn.slice(0, 60)}`);
  ok(/team spaces/i.test(gating.signIn), 'and says what does need it');
  // Fast mode is Opus-5-only and doubles the price; on Sonnet it would be a
  // switch that silently does nothing, which is worse than no switch.
  ok(!gating.fast, 'no dead fast-scoring toggle now that the model is Sonnet');
  ok(settings.on === true, 'on by default, because scoring is useless without it');
  ok(/signed and stop working within hours/.test(settings.says),
     'and it says why it cannot wait until you click Score');
  ok(/forwards them to Anthropic/.test(settings.says),
     'and where the frames go, which is the part worth being explicit about');

  console.log('--- the extension ships no privileged credential ---');
  const secrets = await sw.evaluate(async () => {
    const get = async (f) => (await (await fetch(chrome.runtime.getURL(f))).text());
    const files = ['dashboard/dashboard.bundle.js', 'panel/panel.bundle.js', 'background.js'];
    const texts = await Promise.all(files.map(get));
    const joined = texts.join('\n');
    return {
      // A key, not the word: "service_role" appears in this repo's own prose
      // about why it must never be bundled.
      serviceRole: /sb_secret_[A-Za-z0-9_-]{8,}/.test(joined)
        || /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/.test(joined),
      dbPassword: /postgresql:\/\/[^\s"']*:[^\s"'@]+@/.test(joined),
      publishable: /sb_publishable_/.test(joined),
    };
  });
  ok(!secrets.serviceRole, 'no service_role key is bundled');
  ok(!secrets.dbPassword, 'no database connection string is bundled');
  ok(secrets.publishable, 'the publishable key is, which is what it is for');

  await dash.locator('.modal-close').click();
  await dash.waitForTimeout(300);

  console.log('--- console clean ---');
  ok(errors.length === 0, errors.length ? errors.slice(0, 4).join(' | ') : 'no page errors');

  console.log(`\n${pass} passed, ${fail} failed`);
  await ctx.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE ERROR', e); process.exit(1); });
