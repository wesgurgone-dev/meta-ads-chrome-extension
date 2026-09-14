/**
 * Loads the unpacked extension in headless Chromium and drives the real
 * background, content and side-panel code.
 *
 *   PW=/path/to/playwright CHROME=/path/to/chromium node tests/side-panel.test.cjs
 *
 * Headless has no browser side-panel UI, so the panel page is opened as an
 * ordinary tab. That exercises every line of panel.js; what it cannot cover is
 * Chrome's own docking chrome around it.
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
    require('os').tmpdir() + '/mal-side-panel-' + Date.now(),
    {
      headless: true, executablePath: CHROME,
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
      viewport: { width: 1280, height: 900 },
    });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const extId = new URL(sw.url()).host;

  const errors = [];
  const watch = (p) => {
    p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('ERR_')) errors.push('console: ' + m.text()); });
  };

  console.log('--- manifest declares a real browser side panel ---');
  const mf = await sw.evaluate(() => chrome.runtime.getManifest());
  ok(mf.side_panel && mf.side_panel.default_path === 'panel/panel.html', 'side_panel.default_path set');
  ok(mf.permissions.includes('sidePanel'), 'sidePanel permission requested');
  ok(!mf.action.default_popup, 'no popup, so Chrome opens the panel on the action click');
  ok(!mf.permissions.includes('scripting'), 'no scripting permission: nothing is injected any more');

  console.log('--- content script still decorates Ad Library cards ---');
  const lib = await ctx.newPage();
  watch(lib);
  await lib.route(/facebook\.com\/ads\/library/, (r) => r.fulfill({ contentType: 'text/html', body: LIB_PAGE }));
  await lib.goto('https://www.facebook.com/ads/library/?q=hyro');
  await lib.waitForTimeout(2600);
  ok(await lib.locator('.mal-bar').count() === 2, 'both cards get their action row');
  ok(await lib.locator('#mal-panel').count() === 0, 'and no panel is injected into the page any more');

  console.log('--- the page answers the panel over GET_PAGE_ADS ---');
  const report = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'https://www.facebook.com/ads/library*' });
    return chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_PAGE_ADS' });
  });
  ok(report && report.ok === true, 'responds');
  ok(report.onLibrary === true, 'reports it is on the Ad Library');
  ok(report.ads.length === 2, `reports both ads (${report.ads.length})`);
  ok(report.decorated === 2, `reports 2 decorated (${report.decorated})`);
  ok(typeof report.ads[0].libraryUrl === 'string', 'each ad carries its Library link');

  console.log('--- a page with no content script answers nothing, not an error ---');
  const blank = await ctx.newPage();
  watch(blank);
  await blank.route(/facebook\.com\/marketplace/, (r) => r.fulfill({ contentType: 'text/html', body: '<html><body>hi</body></html>' }));
  await blank.goto('https://www.facebook.com/marketplace');
  const quiet = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'https://www.facebook.com/marketplace*' });
    try {
      await chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_PAGE_ADS' });
      return 'answered';
    } catch (e) { return 'rejected'; }
  });
  ok(quiet === 'rejected', 'rejects, which the panel reads as "nothing on this page"');

  console.log('--- the panel page itself ---');
  const panel = await ctx.newPage();
  watch(panel);
  await panel.setViewportSize({ width: 400, height: 820 });
  await panel.goto(`chrome-extension://${extId}/panel/panel.html`);
  await panel.waitForTimeout(1400);

  ok(await panel.locator('#tabs .tab').count() === 4, 'four tabs render');
  ok(await panel.locator('.head').isVisible(), 'header renders');
  ok(await panel.locator('#btn-library').isVisible(), 'Go to Ad Library shows (panel tab is not the Library)');

  console.log('--- mesh ground uses the brand ramp ---');
  const mesh = await panel.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('.mesh'));
    return { image: cs.backgroundImage, filter: cs.filter };
  });
  for (const [hex, rgb] of [['#070707', 'rgb(7, 7, 7)'], ['#4510e8', 'rgb(69, 16, 232)'],
                            ['#ed0cdd', 'rgb(237, 12, 221)'], ['#ffc41d', 'rgb(255, 196, 29)'],
                            ['#ffffff', 'rgb(255, 255, 255)']])
    ok(mesh.image.includes(rgb), `ramp stop ${hex} present`);
  ok(/blur\(/.test(mesh.filter), 'blurred into a mesh rather than a hard ramp');

  console.log('--- every bubble is liquid glass ---');
  const glass = await panel.evaluate(() =>
    [...document.querySelectorAll('.bubble')].map((n) => {
      const cs = getComputedStyle(n);
      return {
        cls: n.className,
        blur: cs.backdropFilter || cs.webkitBackdropFilter,
        translucent: /rgba\([^)]+,\s*0?\.\d+\)/.test(cs.backgroundColor),
        sheen: getComputedStyle(n, '::before').backgroundImage !== 'none',
      };
    }));
  ok(glass.length >= 4, `${glass.length} bubbles on screen`);
  ok(glass.every((g) => /blur\(/.test(g.blur)), 'all blur what is behind them');
  ok(glass.every((g) => /saturate\(/.test(g.blur)), 'all saturate it too');
  ok(glass.every((g) => g.translucent), 'none of them is opaque');
  ok(glass.every((g) => g.sheen), 'all carry the specular sheen');

  console.log('--- SF Pro first in the stack, not bundled ---');
  const font = await panel.evaluate(() => getComputedStyle(document.body).fontFamily);
  ok(/^"?SF Pro Display"?/.test(font), `SF Pro Display leads (${font.slice(0, 40)}...)`);
  ok(/-apple-system/.test(font) && /Inter/.test(font), 'with system and Inter fallbacks');
  const fontFiles = await sw.evaluate(async () => {
    const res = await fetch(chrome.runtime.getURL('panel/panel.css'));
    return /@font-face/.test(await res.text());
  });
  ok(!fontFiles, 'no @font-face: Apple\'s font is not redistributed');

  console.log('--- views switch ---');
  for (const [view, needle] of [['saved', 'saved in this space'], ['lists', 'Lists in this space'], ['account', 'Space']]) {
    await panel.locator(`#tabs .tab[data-view="${view}"]`).click();
    await panel.waitForTimeout(350);
    // innerText returns the CSS-transformed text, and section labels are
    // uppercase, so compare case-insensitively.
    const txt = (await panel.locator('#view').innerText()).toLowerCase();
    ok(txt.includes(needle.toLowerCase()), `${view} view renders (${needle})`);
  }
  await panel.locator('#tabs .tab[data-view="home"]').click();
  await panel.waitForTimeout(300);
  ok(await panel.locator('#tabs .tab[aria-selected="true"]').getAttribute('data-view') === 'home',
     'selected tab tracks the view');

  console.log('--- theme switch reaches the panel ---');
  await panel.locator('#tabs .tab[data-view="account"]').click();
  await panel.waitForTimeout(300);
  await panel.locator('#view .tabs .tab', { hasText: 'Dark' }).click();
  await panel.waitForTimeout(500);
  ok(await panel.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'dark applied');
  await panel.locator('#view .tabs .tab', { hasText: 'Light' }).click();
  await panel.waitForTimeout(500);
  ok(await panel.evaluate(() => document.documentElement.dataset.theme) === 'light', 'light applied');

  await panel.locator('#tabs .tab[data-view="home"]').click();
  await panel.waitForTimeout(400);
  await panel.screenshot({ path: (process.env.SHOT_DIR || require('os').tmpdir()) + '/side-panel.png' });

  console.log('--- console clean ---');
  ok(errors.length === 0, errors.length ? errors.join(' | ') : 'no page errors');

  console.log(`\n${pass} passed, ${fail} failed`);
  await ctx.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE ERROR', e); process.exit(1); });
