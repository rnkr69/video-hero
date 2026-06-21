import { chromium } from 'playwright';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { cursorKit } from './cursor-kit.js';
import { rawDir, ensureDir } from './layout.js';

// Where Playwright caches downloaded browsers, per platform.
function playwrightBrowsersDir() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || homedir(), 'ms-playwright');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Caches', 'ms-playwright');
  }
  return join(homedir(), '.cache', 'ms-playwright'); // linux & others
}

// Optional: locate an installed headless-shell if node_modules/browser revisions
// mismatch (otherwise just rely on `npx playwright install chromium`). Best-effort and
// cross-platform: returns undefined if not found, so Playwright falls back to its bundled browser.
function findExecutable() {
  const base = playwrightBrowsersDir();
  if (!existsSync(base)) return undefined;
  const dir = readdirSync(base).find((d) => d.startsWith('chromium_headless_shell'));
  if (!dir) return undefined;
  // The per-OS subfolder ('...-win64', '...-mac-arm64', '...-linux', …) and binary name vary; find
  // the platform folder by prefix and add the .exe suffix only on Windows.
  const root = join(base, dir);
  let sub;
  try { sub = readdirSync(root).find((d) => d.startsWith('chrome-headless-shell')); }
  catch { return undefined; }
  if (!sub) return undefined;
  const bin = process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';
  const p = join(root, sub, bin);
  return existsSync(p) ? p : undefined;
}

// The headless-shell binary can't run headed. Only use it in headless mode; for headed
// (probe, login) let Playwright pick its bundled full Chromium.
const execPathFor = (headless) => (headless ? findExecutable() : undefined);

class Driver {
  constructor(page) {
    this.page = page;
    this.t0 = Date.now();   // overwritten by record() to align with the video start
    this.idle = [];         // [start,end] seconds of "nothing happening" (the holds)
    this.captions = [];     // [{t,text}] caption events; each lasts until the next one
  }
  goto(url, opts = {}) { return this.page.goto(url, { waitUntil: 'networkidle', ...opts }); }
  // A static pause. Recorded as an idle segment so encode.speedupIdle can compress it.
  async hold(ms) {
    const start = (Date.now() - this.t0) / 1000;
    await this.page.waitForTimeout(ms);
    this.idle.push([start, (Date.now() - this.t0) / 1000]);
  }
  // Set the on-screen caption from NOW until the next caption() (or end). Empty/null clears it.
  caption(text) {
    this.captions.push({ t: (Date.now() - this.t0) / 1000, text: text == null ? '' : String(text) });
  }
  moveTo(sel, ms) { return this.page.evaluate(([s, m]) => window.__demo.moveToSel(s, m), [sel, ms]); }
  type(sel, text, cps) { return this.page.evaluate(([s, t, c]) => window.__demo.typeInto(s, t, c), [sel, text, cps]); }
  zoomTo(sel, scale, ms) { return this.page.evaluate(([s, sc, m]) => window.__demo.zoomToSel(s, sc, m), [sel, scale, ms]); }
  // Auto-zoom: frame an element's bounding box (scale auto-derived; see cursor-kit frameTo).
  zoomToFit(sel, opts = {}) { return this.page.evaluate(([s, o]) => window.__demo.frameTo(s, o), [sel, opts]); }
  resetZoom(ms) { return this.page.evaluate((m) => window.__demo.reset(m), ms); }
  waitFor(selOrFn, opts = {}) {
    const timeout = this.waitTimeout || 20000; // configurable per recorder (waitTimeout)
    if (typeof selOrFn === 'function') return this.page.waitForFunction(selOrFn, undefined, { timeout, ...opts });
    return this.page.waitForSelector(selOrFn, { timeout, ...opts });
  }
  // Click with cursor move + pulse.
  //   {nav:true}  — full-page navigation link (waits for navigation; ignores zoom).
  //   {zoom}      — auto-zoom AFTER the click. true=frame the clicked element,
  //                 a selector string=frame that element, a number=fixed scale on the
  //                 clicked element, an object={sel?,scale?,fill?,max?,ms?}. Defaults to
  //                 the recorder-wide `autoZoom` mode when omitted; pass false to opt out.
  async click(sel, { nav = false, ms, zoom } = {}) {
    if (nav) {
      const { x, y } = await this.page.evaluate(([s, m]) => window.__demo.moveToSel(s, m), [sel, ms]);
      await this.page.evaluate(([x, y]) => window.__demo.pulse(x, y), [x, y]);
      await Promise.all([
        this.page.waitForNavigation({ waitUntil: 'networkidle' }),
        this.page.evaluate((s) => window.__demo.resolveEl(s).click(), sel),
      ]);
      return;
    }
    await this.page.evaluate(([s, m]) => window.__demo.clickSel(s, m), [sel, ms]);
    const z = zoom ?? (this.autoZoom ? true : null);
    if (z) {
      const target = typeof z === 'string' ? z : (typeof z === 'object' && z.sel) ? z.sel : sel;
      const opts = typeof z === 'number' ? { scale: z } : (typeof z === 'object' ? z : {});
      await this.zoomToFit(target, opts);
    }
  }
}

export { Driver };

// Simple glob match for route rules: '*' is wildcard; a pattern without '*' is a substring.
const matchUrl = (pattern, url) => {
  if (!pattern.includes('*')) return url.includes(pattern);
  const re = new RegExp('^' + pattern.split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(url);
};

// Pure glob matcher exposed ONLY for unit tests (not part of the public API).
export const __test = { matchUrl };

// Selective interception: pin ONLY the non-deterministic requests, pass the rest to the
// real backend. Rules are tried in order; first match wins. Each rule has a `url`
// (glob/substring) and one action:
//   { json }            -> fulfill with canned JSON (the common case)
//   { body, contentType, status } -> fulfill with arbitrary body
//   { file, contentType }-> fulfill with a local file's contents
//   { redirect }/{ mock }-> route the request to another URL (same protocol; e.g. a local
//                           mock SSE server for streaming endpoints route.fulfill can't stream)
//   { abort: true }      -> block the request (telemetry/ads/noise)
// No matching rule -> route.continue() (hits the real backend).
async function applyRoutes(context, rules) {
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    const rule = rules.find((r) => matchUrl(r.url, url));
    if (!rule) return route.continue();
    if (rule.abort) return route.abort();
    if (rule.redirect || rule.mock) return route.continue({ url: rule.redirect || rule.mock });
    if (rule.json !== undefined) {
      return route.fulfill({ status: rule.status || 200,
        contentType: 'application/json; charset=UTF-8', body: JSON.stringify(rule.json) });
    }
    if (rule.file !== undefined) {
      return route.fulfill({ status: rule.status || 200,
        ...(rule.contentType ? { contentType: rule.contentType } : {}), body: readFileSync(rule.file) });
    }
    if (rule.body !== undefined) {
      return route.fulfill({ status: rule.status || 200,
        contentType: rule.contentType || 'text/plain; charset=UTF-8', body: rule.body });
    }
    return route.continue();
  });
}

// Log in once and persist the session (cookies + localStorage) to `out`, so demo
// recordings can start authenticated via record({ storageState: out }). Headed by
// default so you can complete MFA / captcha by hand if the flow can't. Put credentials
// in env vars and reference them from the flow — never hardcode secrets.
export async function saveAuth(flow, { url, out = 'auth.json', headless = false, width = 1280, height = 800 } = {}) {
  const browser = await chromium.launch({ headless, executablePath: execPathFor(headless) });
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  await page.addInitScript(cursorKit);
  const driver = new Driver(page);
  if (url) await driver.goto(url);
  try { await flow(driver, page); }
  finally {
    await context.storageState({ path: out });
    await browser.close();
  }
  return out;
}

// Open a browser session (context + page + Driver) with the kit injected, routes applied
// and waitTimeout set. Used by record() (with recordVideo) and probe() (without). The
// caller owns navigation and closing.
export async function openSession({
  outDir = 'out', width = 1280, height = 800, scale = 2, headless = true, autoZoom = false,
  storageState, routes, waitTimeout, recordVideo = false,
} = {}) {
  const browser = await chromium.launch({ headless, executablePath: execPathFor(headless) });
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: scale,
    // Raw recordings live in out/raw/ (kept tidy, pruned to the last few) — not the out/ root.
    ...(recordVideo ? { recordVideo: { dir: ensureDir(rawDir(outDir)), size: { width, height } } } : {}),
    // Start authenticated if a saved session exists (see saveAuth).
    ...(storageState && existsSync(storageState) ? { storageState } : {}),
  });
  const t0 = Date.now(); // recordVideo begins ~now (context creation); anchor idle marks here
  // Pin non-deterministic requests before any navigation so the first load is covered too.
  if (routes && routes.length) await applyRoutes(context, routes);
  const page = await context.newPage();
  await page.addInitScript(cursorKit);
  const driver = new Driver(page);
  driver.t0 = t0;
  driver.autoZoom = autoZoom;       // when true, every non-nav click auto-frames its target
  if (waitTimeout) driver.waitTimeout = waitTimeout;
  return { browser, context, page, driver };
}

export async function record(flow, opts = {}) {
  const { url, onGoto } = opts;
  const { browser, context, page, driver } = await openSession({ ...opts, recordVideo: true });
  if (url) { await driver.goto(url); if (onGoto) await onGoto(page); }
  let videoPath;
  try {
    await flow(driver, page);
  } finally {
    // NOTE: no `return` here — a `return` in finally would swallow any error thrown
    // by the flow and silently leave you with a truncated recording.
    await context.close(); // finalizes the .webm
    videoPath = await page.video()?.path();
    await browser.close();
  }
  // Sidecars (aligned to the video timeline): idle segments for speedupIdle, and
  // caption events for buildSrt/burnSubs.
  if (videoPath && driver.idle.length) {
    try { writeFileSync(`${videoPath}.idle.json`, JSON.stringify({ idle: driver.idle })); }
    catch { /* non-fatal */ }
  }
  if (videoPath && driver.captions.length) {
    try { writeFileSync(`${videoPath}.captions.json`, JSON.stringify({ captions: driver.captions })); }
    catch { /* non-fatal */ }
  }
  return videoPath;
}
