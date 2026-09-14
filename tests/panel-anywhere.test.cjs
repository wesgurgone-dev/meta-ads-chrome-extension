// Loads the unpacked extension in headless Chromium and drives the real
// background/content scripts. Needs playwright and a Chromium binary:
//   PW=/path/to/playwright CHROME=/path/to/chromium node tests/panel-anywhere.test.cjs
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

// A perfectly ordinary page that happens to contain a long digit run, which is
// what decoration keys off on the Library.
const OTHER_PAGE = `<!doctype html><html><body style="margin:0;font-family:sans-serif">
  <h1>Some unrelated site</h1>
  <p>Order reference 853222324181295 shipped on Jan 15, 2026.</p>
</body></html>`;

(async () => {
  const ctx = await chromium.launchPersistentContext(require('os').tmpdir() + '/mal-panel-anywhere-' + Date.now(), {
    headless: true, executablePath: CHROME,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
    viewport: { width: 1500, height: 900 },
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });

  const errors = [];
  const watch = (p) => {
    p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('ERR_')) errors.push('console: ' + m.text()); });
  };

  // What the toolbar handler does when nothing answers in the tab.
  const openPanelByInjection = async (page) => sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' });
      return 'existing';
    } catch (e) { /* no content script yet */ }
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content/content.css'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/content.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL', open: true });
    return 'injected';
  });

  console.log('--- panel opens on a page that is not the Ad Library ---');
  const other = await ctx.newPage();
  watch(other);
  // A non-Library page inside host_permissions. The real toolbar click grants
  // the same access via activeTab on any site, but headless cannot synthesize
  // that gesture, so the injection path is exercised here instead.
  await other.route(/facebook\.com\/marketplace/, (r) => r.fulfill({ contentType: 'text/html', body: OTHER_PAGE }));
  await other.goto('https://www.facebook.com/marketplace');
  const how = await openPanelByInjection(other);
  await other.waitForTimeout(900);
  ok(how === 'injected', 'no content script there, so the background injected one');
  ok(await other.locator('#mal-panel').count() === 1, 'panel exists on a non-Facebook page');
  ok(!(await other.locator('#mal-panel').getAttribute('class')).includes('mal-closed'), 'and it opened rather than toggling shut');

  console.log('--- the Ad Library button shows where it is useful ---');
  ok(await other.locator('#mal-open-library').isVisible(), 'visible off the Ad Library');
  ok(await other.locator('#mal-open-dash').isVisible(), 'dashboard link still there');

  console.log('--- no card decoration off the Ad Library ---');
  ok(await other.locator('.mal-bar').count() === 0, 'a long number in body text is not treated as an ad id');
  const homeText = await other.locator('#mal-view').innerText();
  ok(/Not on the Ad Library/.test(homeText), 'Home says where you are instead of "0 ads on this page"');
  ok(/SAVED/i.test(homeText) && /RECENTLY SAVED/i.test(homeText), 'and still shows the library summary');

  console.log('--- clicking it reaches the Ad Library ---');
  // Asserted through the extension's own tab list, not Playwright's page
  // event: the new tab points at the real facebook.com, which never commits in
  // this sandbox, so Playwright never surfaces it even though it exists.
  await other.locator('#mal-open-library').click();
  await other.waitForTimeout(1500);
  const libTabs = await sw.evaluate(() =>
    chrome.tabs.query({}).then((t) =>
      t.map((x) => x.url || x.pendingUrl || '').filter((u) => /ads\/library/.test(u))),
  );
  ok(libTabs.length === 1, `opened one Ad Library tab (${JSON.stringify(libTabs)})`);
  await sw.evaluate(() =>
    chrome.tabs.query({}).then((t) =>
      Promise.all(t.filter((x) => /ads\/library/.test(x.url || x.pendingUrl || ''))
        .map((x) => chrome.tabs.remove(x.id)))),
  );

  console.log('--- re-injection is a no-op, not a second panel ---');
  const again = await openPanelByInjection(other);
  await other.waitForTimeout(400);
  ok(again === 'existing', 'second click talks to the script already there');
  ok(await other.locator('#mal-panel').count() === 1, 'still exactly one panel');
  ok((await other.locator('#mal-panel').getAttribute('class')).includes('mal-closed'), 'and that click closed it');

  console.log('--- on the Ad Library itself ---');
  const lib = await ctx.newPage();
  watch(lib);
  await lib.route(/facebook\.com\/ads\/library/, (r) => r.fulfill({ contentType: 'text/html', body: LIB_PAGE }));
  await lib.goto('https://www.facebook.com/ads/library/?q=hyro');
  await lib.waitForTimeout(2600);
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' });
  });
  await lib.waitForTimeout(700);
  ok(await lib.locator('#mal-panel').count() === 1, 'panel opens from the declared content script');
  ok(await lib.locator('#mal-open-library').isHidden(), 'Ad Library button auto-hides here');
  ok(await lib.locator('.mal-bar').count() === 2, 'cards still get their action row (regression)');
  const libHome = await lib.locator('#mal-view').innerText();
  ok(/ads on this page/.test(libHome), 'Home still reports what the page is showing');

  console.log('--- a second request focuses that tab instead of opening another ---');
  const before = await sw.evaluate(() => chrome.tabs.query({}).then((t) => t.length));
  await lib.evaluate(() => {});
  await other.bringToFront();
  await other.waitForTimeout(200);
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL', open: true });
  });
  await other.locator('#mal-open-library').click();
  await other.waitForTimeout(1200);
  const after = await sw.evaluate(() => chrome.tabs.query({}).then((t) => t.length));
  ok(after === before, `no duplicate tab (${before} -> ${after})`);

  console.log('--- console clean ---');
  ok(errors.length === 0, errors.length ? errors.join(' | ') : 'no page errors');

  console.log(`\n${pass} passed, ${fail} failed`);
  await ctx.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE ERROR', e); process.exit(1); });
