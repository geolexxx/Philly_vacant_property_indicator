#!/usr/bin/env node
/*
 * Responsive layout check + screenshots for docs/dashboard.html.
 *
 * Serve docs/ with a server that supports HTTP Range (PMTiles needs it):
 *   npx http-server docs -p 8080
 * Then, from the repo root:
 *   npx -y -p playwright@1.64.1 node scripts/capture_responsive.cjs
 *
 * Options:
 *   --url <url>        page to test (default http://localhost:8080/dashboard.html)
 *   --out <dir>        screenshot folder (default screenshots/, gitignored)
 *   --widths a,b,c     widths to run (default: all listed below; other
 *                      widths use an 800px-tall viewport)
 *   --streetview       also check search results and open Street View at each width
 *   --channel <name>   browser channel, e.g. chrome; by default Playwright's
 *                      Chromium is tried first, then the installed Chrome
 *
 * For each width it saves a screenshot, checks that header and map controls do
 * not overlap or overflow, checks the map's share of the viewport height
 * (>= 60% at 390x844 with the drawer closed) and, under 900px, that the
 * "Filters & legend" drawer opens, closes on Escape and returns focus. The
 * 390px run also checks focus when crossing the desktop breakpoint.
 * Exits with code 1 if any check fails.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const VIEWPORTS = [
  [360, 800], [390, 844], [768, 1024], [1024, 768],
  [1280, 800], [1440, 900], [1920, 1080]
];
const SEARCH_QUERY = '121126100'; // a flagged parcel (298 E Queen Ln)

function loadPlaywright() {
  const candidates = ['playwright', 'playwright-core'];
  for (const name of candidates) {
    try { return require(name); } catch (_) { /* try next */ }
  }
  // `npx -p playwright node ...` puts the package's .bin on PATH but not on
  // the require path, so look next to each node_modules/.bin entry.
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir.endsWith(path.join('node_modules', '.bin'))) continue;
    for (const name of candidates) {
      try { return require(path.join(dir, '..', name)); } catch (_) { /* next */ }
    }
  }
  console.error('Playwright not found. Run: npx -y -p playwright@1.64.1 node scripts/capture_responsive.cjs');
  process.exit(2);
}

function parseArgs(argv) {
  const args = { url: 'http://localhost:8080/dashboard.html', out: 'screenshots', widths: null, streetview: false, channel: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') args.url = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--widths') args.widths = argv[++i].split(',').map(Number);
    else if (a === '--streetview') args.streetview = true;
    else if (a === '--channel') args.channel = argv[++i];
    else { console.error(`Unknown option ${a}`); process.exit(2); }
  }
  return args;
}

async function launch(chromium, channel) {
  if (channel) return chromium.launch({ channel });
  try { return await chromium.launch(); }
  catch (_) { return chromium.launch({ channel: 'chrome' }); }
}

// Runs in the page: rectangles of visible controls that must not collide.
function collectLayout() {
  const visible = el => {
    if (!el) return false;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  const items = [];
  const add = (name, el, group) => {
    if (!visible(el)) return;
    const r = el.getBoundingClientRect();
    items.push({ name, group, x: r.left, y: r.top, w: r.width, h: r.height,
      clipped: el.scrollWidth > el.clientWidth + 1 });
  };
  add('brand', document.querySelector('.header-brand'), 'header');
  add('badge', document.querySelector('.badge-experimental'), 'header');
  add('about', document.getElementById('about-btn'), 'header');
  add('overview', document.querySelector('.header-back'), 'header');
  add('search-input', document.getElementById('search-input'), 'map');
  add('search-btn', document.getElementById('search-btn'), 'map');
  document.querySelectorAll('.view-tab').forEach((t, i) => add(`tab-${i + 1}`, t, 'map'));
  add('info-badge', document.getElementById('map-info-badge'), 'map');
  add('nav-ctrl', document.querySelector('.maplibregl-ctrl-bottom-left .maplibregl-ctrl'), 'map');
  add('attribution', document.querySelector('.maplibregl-ctrl-attrib'), 'map');
  add('drawer-toggle', document.getElementById('drawer-toggle'), 'app');
  const header = document.getElementById('header');
  const title = document.querySelector('.header-brand-label .brand-title');
  const mapBox = document.getElementById('map-container').getBoundingClientRect();
  return {
    items,
    vw: innerWidth,
    vh: innerHeight,
    pageOverflow: document.documentElement.scrollWidth > innerWidth,
    headerOverflow: header.scrollWidth > header.clientWidth + 1 ||
      Boolean(title && title.scrollWidth > title.clientWidth + 1),
    headerHeight: header.getBoundingClientRect().height,
    map: { x: mapBox.left, y: mapBox.top, w: mapBox.width, h: mapBox.height }
  };
}

function checkLayout(layout) {
  const problems = [];
  const { items, vw, map } = layout;
  const overlaps = (a, b) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 &&
                             a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    if (a.x < -0.5 || a.x + a.w > vw + 0.5) problems.push(`${a.name} is outside the viewport`);
    if (a.group === 'map' && (a.x < map.x - 0.5 || a.x + a.w > map.x + map.w + 0.5 ||
        a.y < map.y - 0.5 || a.y + a.h > map.y + map.h + 0.5)) problems.push(`${a.name} is clipped by the map`);
    if (a.clipped) problems.push(`${a.name} text is clipped`);
    for (let j = i + 1; j < items.length; j++) {
      if (overlaps(a, items[j])) problems.push(`${a.name} overlaps ${items[j].name}`);
    }
  }
  if (layout.pageOverflow) problems.push('page scrolls horizontally');
  if (layout.headerOverflow) problems.push('header content overflows or is truncated');
  if (vw <= 900 && map.w < vw - 0.5) problems.push(`map is ${Math.round(map.w)}px wide, not the full width`);
  return problems;
}

async function waitForMap(page) {
  await page.waitForSelector('.maplibregl-canvas', { timeout: 30000 });
  await page.evaluate(() => new Promise(resolve => {
    const done = () => setTimeout(resolve, 300);
    // `map` is a top-level binding in dashboard.html.
    // eslint-disable-next-line no-undef
    if (typeof map === 'undefined' || !map) return done();
    // eslint-disable-next-line no-undef
    if (map.loaded() && map.areTilesLoaded()) return done();
    // eslint-disable-next-line no-undef
    map.once('idle', done);
    setTimeout(resolve, 15000);
  }));
  await page.evaluate(() => document.fonts && document.fonts.ready);
}

async function checkDrawer(page, problems) {
  const toggle = page.locator('#drawer-toggle');
  if (!(await toggle.isVisible())) { problems.push('drawer toggle is not visible under 900px'); return; }
  await toggle.focus();
  await page.keyboard.press('Enter');
  const opened = await page.evaluate(() => ({
    expanded: document.getElementById('drawer-toggle').getAttribute('aria-expanded'),
    sidebarVisible: getComputedStyle(document.getElementById('sidebar')).display !== 'none'
  }));
  if (opened.expanded !== 'true' || !opened.sidebarVisible) problems.push('drawer did not open from the keyboard');
  return async () => {
    const about = page.locator('#about-btn');
    await about.click();
    await page.keyboard.press('Escape');
    if (await page.locator('#aboutModal').isVisible()
        || await toggle.getAttribute('aria-expanded') !== 'true'
        || !(await about.evaluate(el => el === document.activeElement))) {
      problems.push('Escape did not close About and leave the drawer open');
    }
    await page.keyboard.press('Escape');
    const closed = await page.evaluate(() => ({
      expanded: document.getElementById('drawer-toggle').getAttribute('aria-expanded'),
      sidebarVisible: getComputedStyle(document.getElementById('sidebar')).display !== 'none',
      focus: document.activeElement && document.activeElement.id
    }));
    if (closed.expanded !== 'false' || closed.sidebarVisible) problems.push('Escape did not close the drawer');
    if (closed.focus !== 'drawer-toggle') problems.push('focus did not return to the drawer toggle');
  };
}

async function checkBreakpointFocus(page, problems) {
  const original = page.viewportSize();
  try {
    await page.locator('#drawer-toggle').focus();
    await page.setViewportSize({ width:1280, height:original.height });
    await page.waitForFunction(() => document.activeElement.id === 'choro-level', null, { timeout:3000 });
    await page.setViewportSize(original);
    await page.waitForFunction(() => document.activeElement.id === 'drawer-toggle', null, { timeout:3000 });
    if (await page.locator('#sidebar').isVisible()) problems.push('sidebar opened during breakpoint focus transfer');
  } catch (_) {
    problems.push('focus was lost across the drawer breakpoint');
  } finally {
    await page.setViewportSize(original);
  }
}

async function findParcel(page, problems) {
  const input = page.locator('#search-input');
  const results = page.locator('#search-results');
  const first = results.locator('button.sri').first();
  async function search() {
    await input.press('Enter');
    await first.waitFor({ timeout: 20000 });
  }
  await input.fill(SEARCH_QUERY);
  await search();
  const resultsTop = (await results.boundingBox()).y;
  const toolbar = await page.locator('#map-toolbar').boundingBox();
  if (resultsTop < toolbar.y + toolbar.height) problems.push('search results cover the toolbar');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  if (!(await first.evaluate(el => el === document.activeElement))) problems.push('the first search result is unreachable with Tab');
  await page.keyboard.press('Tab');
  if (!(await results.isHidden())
      || !(await page.locator('.view-tab').first().evaluate(el => el === document.activeElement))) {
    problems.push('Tab did not dismiss search results and reach the first view tab');
  }
  await search();
  await page.keyboard.press('Escape');
  if (!(await results.isHidden()) || !(await input.evaluate(el => el === document.activeElement))) {
    problems.push('Escape did not dismiss search results and return focus to search');
  }
  await search();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
}

async function openStreetView(page, problems) {
  await findParcel(page, problems);
  const btn = page.locator('.popup-streetview-btn');
  await btn.waitFor({ timeout: 20000 });
  const toggle = page.locator('#drawer-toggle');
  if (await toggle.isVisible()) {
    await toggle.click();
    try {
      await page.waitForFunction(() => {
        const button = document.querySelector('.popup-streetview-btn');
        const { x, y, width, height } = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(x + width / 2, y + height / 2));
      }, null, { timeout:2000 });
    } catch (_) {
      problems.push('the open drawer clips the Street View button');
    }
  }
  await btn.click();
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') !== 'false') {
    problems.push('opening Street View did not close the drawer');
  }
  await page.waitForTimeout(800);
  const state = await page.evaluate(() => {
    const rect = el => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.height ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
    };
    const panel = document.getElementById('streetview-panel');
    return {
      hidden: panel.hidden,
      panel: rect(panel) || { x: 0, y: 0, w: 0, h: 0 },
      map: rect(document.getElementById('map-container')),
      toggle: rect(document.getElementById('drawer-toggle')),
      toolbar: rect(document.getElementById('map-toolbar')),
      popup: rect(document.querySelector('.maplibregl-popup')),
      focus: document.activeElement && document.activeElement.id,
      vw: innerWidth, vh: innerHeight
    };
  });
  const overlaps = (a, b) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 &&
                             a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
  if (state.hidden) problems.push('Street View panel did not open');
  if (overlaps(state.panel, state.map)) problems.push('Street View panel covers the map');
  if (state.toggle && overlaps(state.panel, state.toggle)) problems.push('Street View panel covers the drawer toggle');
  if (state.panel.x + state.panel.w > state.vw + 0.5 || state.panel.y + state.panel.h > state.vh + 0.5) problems.push('Street View panel overflows the viewport');
  if (state.focus !== 'streetview-close') problems.push('focus did not move to the Street View close button');
  if (state.popup && state.toolbar && overlaps(state.popup, state.toolbar)) problems.push('popup is hidden under the toolbar');
  return async () => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const closed = await page.evaluate(() => ({
      hidden: document.getElementById('streetview-panel').hidden,
      focusInPopup: Boolean(document.activeElement && document.activeElement.closest('.maplibregl-popup')),
      popupShown: Boolean(document.querySelector('.maplibregl-popup')?.getBoundingClientRect().height)
    }));
    if (!closed.hidden) problems.push('Escape did not close Street View');
    if (!closed.popupShown || !closed.focusInPopup) problems.push('closing Street View did not return focus to the popup');
  };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const { chromium } = loadPlaywright();
  fs.mkdirSync(args.out, { recursive: true });
  const browser = await launch(chromium, args.channel);
  let failures = 0;
  const viewports = args.widths
    ? args.widths.map(w => VIEWPORTS.find(([vw]) => vw === w) || [w, 800])
    : VIEWPORTS;
  for (const [width, height] of viewports) {
    const page = await browser.newPage({ viewport: { width, height } });
    const problems = [];
    await page.goto(args.url, { waitUntil: 'load' });
    await waitForMap(page);
    const layout = await page.evaluate(collectLayout);
    problems.push(...checkLayout(layout));
    const mapShare = layout.map.h / layout.vh;
    if (width === 390 && height === 844 && mapShare < 0.6) problems.push(`map is ${(mapShare * 100).toFixed(0)}% of the viewport height (< 60%)`);
    const name = `dashboard-${width}x${height}`;
    await page.screenshot({ path: path.join(args.out, `${name}.png`) });

    if (width <= 900) {
      const closeDrawer = await checkDrawer(page, problems);
      if (closeDrawer) {
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(args.out, `${name}-drawer.png`) });
        await closeDrawer();
      }
      if (width === 390) await checkBreakpointFocus(page, problems);
    }
    if (args.streetview) {
      try {
        const closeStreetView = await openStreetView(page, problems);
        await page.screenshot({ path: path.join(args.out, `${name}-streetview.png`) });
        await closeStreetView();
      } catch (err) { problems.push(`Street View flow failed: ${err.message.split('\n')[0]}`); }
    }

    failures += problems.length;
    const status = problems.length ? 'FAIL' : 'ok  ';
    console.log(`${status} ${String(width).padStart(4)}x${height}  map ${(mapShare * 100).toFixed(0)}% of height${problems.length ? '\n       - ' + problems.join('\n       - ') : ''}`);
    await page.close();
  }
  await browser.close();
  console.log(`Screenshots in ${path.resolve(args.out)}`);
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); process.exit(2); });
