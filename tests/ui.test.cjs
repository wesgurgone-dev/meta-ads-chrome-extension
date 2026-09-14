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
const card = (id, name) => `
  <div class="card" style="width:330px;border:1px solid #ddd;padding:12px;display:flex;flex-direction:column">
    <div style="display:flex;gap:8px"><div role="button" tabindex="0" style="flex:1">See ad details</div></div>
    <div><strong>${name}</strong> Sponsored</div>
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="290" height="180" />
    <div>Library ID: ${id}</div>
    <div>Started running on Jan 15, 2026</div>
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

  const errors = [];
  const watch = (p, tag) => {
    p.on('pageerror', (e) => errors.push(`${tag} pageerror: ${e.message}`));
    p.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('ERR_')) errors.push(`${tag} console: ${m.text()}`);
    });
  };

  console.log('--- manifest ---');
  const mf = await sw.evaluate(() => chrome.runtime.getManifest());
  ok(mf.side_panel && mf.side_panel.default_path === 'panel/panel.html', 'side_panel declared');
  ok(mf.permissions.includes('sidePanel'), 'sidePanel permission');
  ok(!mf.action.default_popup, 'no popup, so Chrome opens the panel on the action click');
  ok(!mf.permissions.includes('scripting'), 'nothing is injected any more');

  console.log('--- bundles are MV3-safe ---');
  const bundles = await sw.evaluate(async () => {
    const get = async (f) => (await (await fetch(chrome.runtime.getURL(f))).text());
    const [panel, dash] = await Promise.all([
      get('panel/panel.bundle.js'),
      get('dashboard/dashboard.bundle.js'),
    ]);
    const bad = (s) => /\beval\s*\(/.test(s) || /new\s+Function\s*\(/.test(s) || /sourceMappingURL=data:/.test(s);
    return { panelKB: Math.round(panel.length / 1024), dashKB: Math.round(dash.length / 1024),
             panelBad: bad(panel), dashBad: bad(dash) };
  });
  ok(!bundles.panelBad && !bundles.dashBad, 'no eval, no new Function, no inline source map');
  ok(bundles.panelKB < 400 && bundles.dashKB < 400,
     `bundles stay reasonable (panel ${bundles.panelKB}KB, dashboard ${bundles.dashKB}KB)`);

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
  ok(refract.renderers.join() === 'sdf-svg', `all on the SDF renderer (${refract.renderers.join()})`);
  ok(refract.reasons.join() === 'explicit',
     `chosen explicitly, not fallen back to (${refract.reasons.join()})`);
  ok(refract.displacementMaps >= refract.count,
     `${refract.displacementMaps} displacement maps for ${refract.count} surfaces`);
  ok(refract.filtered === refract.count, 'every surface carries its filter');
  ok(refract.lensesEmpty, 'every lens is empty, so no text is displaced');
  ok(refract.tones.length === 1, `one tone across the panel (${refract.tones.join()})`);

  console.log('--- ground is a dot grid, not a gradient ---');
  const ground = await panel.evaluate(() => {
    const cs = getComputedStyle(document.body);
    return { image: cs.backgroundImage, size: cs.backgroundSize };
  });
  ok(/radial-gradient/.test(ground.image) && /14px/.test(ground.size), `dot grid (${ground.size})`);
  ok(!/#4510e8|rgb\(69, 16, 232\)/.test(ground.image), 'no brand ramp on the ground');

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
  ok(layout.sdf.join() === 'sdf-svg', 'dashboard surfaces refract too');
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

  console.log('--- console clean ---');
  ok(errors.length === 0, errors.length ? errors.slice(0, 4).join(' | ') : 'no page errors');

  console.log(`\n${pass} passed, ${fail} failed`);
  await ctx.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE ERROR', e); process.exit(1); });
