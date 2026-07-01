import { chromium } from 'playwright';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { cursorKit, recorderBridge } from './cursor-kit.js';
import { rawDir, ensureDir } from './layout.js';
import { normalizeCapture } from './capture.js';

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
    this.events = [];       // [{t,kind,...}] visual beats (clicks/zooms/types…) for step-synced SFX
    this.captureMarks = { start: null, end: null }; // capture-window marks (see markCapture)
    // Resolves when the `end` capture mark lands, so record() can close the context early (drop the
    // dead tail). Never rejects; if end never comes, the flow completes normally instead.
    this._captureEnded = new Promise((res) => { this._resolveCaptureEnd = res; });
  }
  // Timestamp a visual beat onto the video timeline (same t0 as idle/captions). Consumed by the
  // SFX stage via the <video>.events.json sidecar.
  mark(kind, extra = {}) {
    this.events.push({ t: (Date.now() - this.t0) / 1000, kind, ...extra });
  }
  // Stamp a capture in/out mark, Node-side, in the SAME clock as mark()/hold()/caption() → the
  // timestamp lines up exactly with the video. Called from the page.exposeBinding the recorder
  // installs. First-wins: the first `start`, and the first `end` at or after that start.
  markCapture(name) {
    const t = (Date.now() - this.t0) / 1000;
    if (name === 'start') { if (this.captureMarks.start == null) this.captureMarks.start = t; return; }
    if (name === 'end') {
      if (this.captureMarks.end != null) return;
      if (this.captureMarks.start != null && t < this.captureMarks.start) return; // end before start → ignore
      this.captureMarks.end = t;
      this._resolveCaptureEnd();
    }
  }
  // A promise that settles when `end` is marked (for early context close).
  captureEnded() { return this._captureEnded; }
  // The element's center + size in VIDEO pixels (CSS px × deviceScaleFactor), for the focus
  // timeline the smart-crop reframe follows. Best-effort: returns null if it can't resolve.
  async _rect(sel) {
    try {
      const r = await this.page.evaluate((s) => {
        const el = window.__demo.resolveEl(s); if (!el) return null;
        const b = el.getBoundingClientRect();
        return { cx: b.left + b.width / 2, cy: b.top + b.height / 2, w: b.width, h: b.height };
      }, sel);
      if (!r) return null;
      const k = this.scale || 1;
      return { cx: r.cx * k, cy: r.cy * k, w: r.w * k, h: r.h * k };
    } catch { return null; }
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
  moveTo(sel, ms, opts = {}) {
    this.mark('move', { sel });
    return this.page.evaluate(([s, m, o]) => window.__demo.moveToSel(s, m, o), [sel, ms, opts]);
  }
  type(sel, text, cps) {
    this.mark('type', { sel });
    return this.page.evaluate(([s, t, c]) => window.__demo.typeInto(s, t, c), [sel, text, cps]);
  }
  async zoomTo(sel, scale, ms) {
    this.mark('zoom', { sel, scale, rect: await this._rect(sel) });
    return this.page.evaluate(([s, sc, m]) => window.__demo.zoomToSel(s, sc, m), [sel, scale, ms]);
  }
  // Auto-zoom: frame an element's bounding box (scale auto-derived; see cursor-kit frameTo).
  // opts.spotlight (true | {dim,pad,radius}) also dims everything but the framed element.
  async zoomToFit(sel, opts = {}) {
    const rect = await this._rect(sel);
    this.mark('zoom', { sel, rect });
    const { spotlight, ...frameOpts } = opts;
    await this.page.evaluate(([s, o]) => window.__demo.frameTo(s, o), [sel, frameOpts]);
    if (spotlight) {
      this.mark('spotlight', { sel, rect });
      const so = (spotlight && typeof spotlight === 'object') ? spotlight : {};
      await this.page.evaluate(([s, o]) => window.__demo.spotlight(s, o), [sel, so]);
    }
  }
  resetZoom(ms) { this.mark('zoomOut'); return this.page.evaluate((m) => window.__demo.reset(m), ms); }
  // Dim everything but `sel` (standalone spotlight; resetZoom/reset clears it).
  async spotlight(sel, opts = {}) {
    this.mark('spotlight', { sel, rect: await this._rect(sel) });
    return this.page.evaluate(([s, o]) => window.__demo.spotlight(s, o), [sel, opts]);
  }
  spotlightOff() { return this.page.evaluate(() => window.__demo.spotlightOff()); }
  // Show pressed keys as on-screen capsules (e.g. 'cmd+k').
  keycap(label, opts = {}) {
    this.mark('keycap', { label });
    return this.page.evaluate(([l, o]) => window.__demo.keycap(l, o), [label, opts]);
  }
  // Smooth eased scroll so `sel` is centered.
  scrollTo(sel, opts = {}) {
    this.mark('scroll', { sel });
    return this.page.evaluate(([s, o]) => window.__demo.scrollToSel(s, o), [sel, opts]);
  }
  // Callout anchored to `sel`: opts.shape box|circle|arrow, opts.text, opts.side. resetZoom/reset
  // (and annotateOff) clear all callouts + highlights.
  annotate(sel, opts = {}) {
    this.mark('annotate', { sel, shape: opts.shape || 'box' });
    return this.page.evaluate(([s, o]) => window.__demo.annotate(s, o), [sel, opts]);
  }
  annotateOff() { return this.page.evaluate(() => window.__demo.annotateOff()); }
  // Animated marker/underline wiped over `sel`'s text.
  highlight(sel, opts = {}) {
    this.mark('highlight', { sel });
    return this.page.evaluate(([s, o]) => window.__demo.highlight(s, o), [sel, opts]);
  }
  // Name the current section. Emits a 'chapter' event (kind+text) the encode stage turns into an
  // animated lower-third. Drawing is post-production (libass), so this is timeline-only here.
  chapter(text) { this.mark('chapter', { text: text == null ? '' : String(text) }); }
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
  async click(sel, { nav = false, ms, zoom, variant, ripple, pop } = {}) {
    if (nav) {
      this.mark('nav', { sel });
      const { x, y } = await this.page.evaluate(([s, m]) => window.__demo.moveToSel(s, m), [sel, ms]);
      await this.page.evaluate(([x, y]) => window.__demo.pulse(x, y), [x, y]);
      await Promise.all([
        this.page.waitForNavigation({ waitUntil: 'networkidle' }),
        this.page.evaluate((s) => window.__demo.resolveEl(s).click(), sel),
      ]);
      return;
    }
    this.mark('click', { sel, variant: variant || 'single', rect: await this._rect(sel) });
    await this.page.evaluate(([s, m, o]) => window.__demo.clickSel(s, m, o), [sel, ms, { variant, ripple, pop }]);
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
  storageState, routes, waitTimeout, recordVideo = false, capture,
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
  driver.scale = scale;             // deviceScaleFactor → CSS px × scale = video px (for smart-crop)
  if (waitTimeout) driver.waitTimeout = waitTimeout;
  // Capture window (opt-in, recording only): let the app declare its content span in-band. Expose a
  // binding that stamps the mark Node-side (same clock as the video), and inject the browser bridge
  // that calls it — from window.__demorecorder.mark(), a CustomEvent, or a watched DOM selector.
  if (recordVideo && capture) {
    driver.capture = capture;
    await page.exposeBinding('__demorecorderMark', (_src, name) => driver.markCapture(name));
    await page.addInitScript(recorderBridge, normalizeCapture(capture));
  }
  return { browser, context, page, driver };
}

export async function record(flow, opts = {}) {
  const { url, onGoto } = opts;
  const { browser, context, page, driver } = await openSession({ ...opts, recordVideo: true });
  if (url) { await driver.goto(url); if (onGoto) await onGoto(page); }
  let videoPath, span;
  // When a capture end-mark is expected (and closeOnEnd isn't disabled), race the flow against it so
  // we can close the context the moment the content ends — trimming the dead tail at the source. The
  // trim in applyCapture also discards anything past the end mark, so this is purely an optimization.
  const closeOnEnd = !!(opts.capture && opts.capture.closeOnEnd !== false);
  try {
    const flowDone = flow(driver, page);
    if (closeOnEnd) {
      // If we abandon the flow after an early close, its pending Playwright calls will reject on a
      // closed context — swallow that so it doesn't surface as an unhandled rejection.
      flowDone.catch(() => {});
      await Promise.race([flowDone, driver.captureEnded()]);
    } else {
      await flowDone;
    }
  } finally {
    // NOTE: no `return` here — a `return` in finally would swallow any error thrown
    // by the flow and silently leave you with a truncated recording.
    await context.close(); // finalizes the .webm
    // Total node span from t0 to close — recorded in the capture sidecar for debugging (it runs a
    // touch longer than the encoded duration because frames stop before close finalizes; that tail
    // gap must NOT be treated as a head offset — see capture.js).
    span = (Date.now() - driver.t0) / 1000;
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
  if (videoPath && driver.events.length) {
    try { writeFileSync(`${videoPath}.events.json`, JSON.stringify({ events: driver.events })); }
    catch { /* non-fatal */ }
  }
  // Capture marks (node clock) + the total node span, so applyCapture can align to the video.
  if (videoPath && opts.capture) {
    try { writeFileSync(`${videoPath}.capture.json`, JSON.stringify({ ...driver.captureMarks, span })); }
    catch { /* non-fatal */ }
  }
  return videoPath;
}
