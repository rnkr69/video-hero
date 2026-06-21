# Blueprint — Scripted demo-video tool (reusable)

> 🌐 **English** · [Español](DEMO_VIDEO_TOOL_BLUEPRINT.md)

> **What this is:** everything you need to assemble, **from scratch and in an empty
> folder**, a reusable tool that generates fluid, **deterministic** product videos
> of any web app, driven by Playwright and orchestrable from **Claude Code**. It's
> the validated result of a pilot (P0/P1): it includes the learnings, the *gotchas*
> and the generalized code ready to copy.
>
> This document is the starting point for an **independent** project. Move it to the
> new folder and start the polish/usage/improvements plan there.

---

## 1. Concept and validated decisions

**Problem:** recording demos by hand (OBS) doesn't come out "fluid" (mouse jitter,
inconsistent timing, manual, not reproducible).

**Validated solution — pipeline:**

```
Deterministic source (mock/canned)
        │
        ▼
Playwright recordVideo (real pixels: captures streaming, canvas, everything)
        │   + injected layer: animated cursor (easing) · char-by-char typing
        │     · click pulse · camera auto-zoom (CSS transform)
        ▼
.webm  ──(real ffmpeg)──▶  .mp4 / .gif
```

**Why this approach (and not others):**

- **Don't build from scratch** the hard parts (physical cursor, auto-zoom, encoding):
  reuse robust pieces (Playwright + ffmpeg) and only write the **thin choreography
  layer**.
- **`playwright-recast`** (the closest OSS tool) was **discarded**: v0.1.0,
  zoom/captions not yet implemented, and it **reconstructs from the trace** (DOM
  snapshots) instead of real pixels → worse fidelity with canvas/streaming.
- **Playwright's `recordVideo`** records **real pixels** → canvas (Chart.js),
  token streaming, CSS animations… everything comes out faithful.
- **Deterministic by design**: fixed responses/timing → the script is **repeatable**
  (no flaky takes, no waiting on an LLM, no tokens, re-renderable in CI).

---

## 2. Critical gotchas (don't rediscover them)

1. **Playwright `route.fulfill()` does NOT stream**: it delivers the body all at once.
   If your app uses SSE/streaming (LLM chat, etc.) and you want to see the incremental
   effect, **don't** mock it with `route.fulfill`. Use one of these two sources:
   - **Your own SSE server** that emits chunks with `await sleep()` between them
     (recommended; see `examples/mock-server.mjs`).
   - **Client-side mock** with a `ReadableStream` that `enqueue`s with delays.
2. **The ffmpeg shipped with Playwright is a stripped build**: only VP8 (for muxing the
   screencast), **no H.264/GIF** and with the **filter parser broken** (`-vf fps=1`
   fails). To encode to mp4/gif use a **real** ffmpeg → the npm package
   `ffmpeg-static` (downloads a complete binary, nothing native to compile).
3. **Extracting frames for self-verification**: with any ffmpeg, the most robust way
   is to seek by timestamp: `ffmpeg -ss <t> -i in.webm -frames:v 1 frame.png`
   (avoids `-vf fps=1`).
4. **Browser revision mismatch**: if `node_modules` ended up installed by a different
   Playwright version than the browser cache, `chromium.launch()` fails. Clean
   solution: `npx playwright install chromium`. Workaround without downloading: pass
   `executablePath` pointing to the installed binary (see `src/recorder.js`).
5. **Shadow DOM**: many widgets (web components) live in a shadow root. To drive them:
   resolve `host >>> inner` and, to type into a `<textarea>`/`<input>` of a custom
   element, use the **native setter** + `dispatchEvent('input')` (a normal `fill` may
   not fire the component's listeners).
6. **Waiting for "end of streaming"**: detect it via DOM (e.g. send button re-enabled,
   absence of the streaming cursor, appearance of the final block).
7. **Quality**: `deviceScaleFactor: 2` + `recordVideo.size` at the viewport size
   → sharp video.
8. **README on GitHub**: GitHub plays back **webm/mp4/mov** uploaded by drag-drop
   (10 MB limit in the web editor). You don't need to encode to publish; the webm
   works. (mp4 H.264 is the most universal if you want it outside GitHub.)

---

## 3. Requirements

- **Node 20+**.
- **Playwright** + the Chromium browser (`npx playwright install chromium`).
- **ffmpeg-static** (only if you want mp4/gif; not needed for webm).
- Your **web app running** at a local (real) URL, **or** a **deterministic
  page/mock server** (recommended for apps with LLM/streaming).

---

## 4. Bootstrap from scratch

```bash
mkdir demo-recorder && cd demo-recorder
npm init -y
npm pkg set type=module
npm i -D playwright ffmpeg-static
npx playwright install chromium
mkdir -p src scripts examples out
```

Target structure:

```
demo-recorder/
├─ package.json
├─ src/
│  ├─ cursor-kit.js     # injected into the page: cursor + zoom + helpers
│  ├─ recorder.js       # harness: launches chromium, records, "Driver" API
│  └─ encode.js         # webm -> mp4 / gif (ffmpeg-static)
├─ examples/
│  └─ mock-server.mjs   # deterministic mock backend (apps with SSE/endpoints)
├─ scripts/
│  └─ record.mjs        # YOUR demo script (uses the Driver)
└─ out/                 # videos + extracted frames
```

---

## 5. Reusable code

### `src/cursor-kit.js`

Injected with `addInitScript` and lives **inside the page** as `window.__demo`.
It includes the synthetic cursor, the camera zoom and the shadow DOM/typing helpers.

```js
// Injected into every navigation via page.addInitScript(cursorKit).
// Exposes window.__demo with the synthetic cursor, camera-zoom, and DOM helpers.
export function cursorKit() {
  let cursor;
  const ensure = () => {
    if (cursor && document.documentElement.contains(cursor)) return;
    cursor = document.createElement('div');
    cursor.style.cssText =
      'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;' +
      'transform:translate(-80px,-80px);transition:transform .6s cubic-bezier(.22,.61,.36,1);' +
      'will-change:transform;filter:drop-shadow(0 2px 3px rgba(0,0,0,.5))';
    cursor.innerHTML =
      '<svg width="26" height="26" viewBox="0 0 24 24"><path ' +
      'd="M5 2.5l15 7.2-6.7 1.6L9.3 20z" fill="#fff" stroke="#1b1d24" ' +
      'stroke-width="1.3" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(cursor);
  };

  // Resolve "host >>> inner >>> deeper" piercing N shadow roots; or a plain selector.
  const resolveEl = (sel) => {
    const parts = sel.split('>>>').map((s) => s.trim());
    let el = document.querySelector(parts[0]);
    for (let i = 1; i < parts.length && el; i++) {
      el = (el.shadowRoot || el).querySelector(parts[i]);
    }
    return el || null;
  };
  const rectOf = (sel) => {
    const el = resolveEl(sel);
    if (!el) throw new Error('element not found: ' + sel);
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, rect: r };
  };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  window.__demo = {
    resolveEl, rectOf,
    move(x, y, ms = 600) {
      ensure();
      cursor.style.transition = `transform ${ms}ms cubic-bezier(.22,.61,.36,1)`;
      cursor.style.transform = `translate(${x - 4}px, ${y - 3}px)`;
      return wait(ms + 40);
    },
    pulse(x, y) {
      const rp = document.createElement('div');
      rp.style.cssText =
        `position:fixed;left:${x}px;top:${y}px;z-index:2147483646;pointer-events:none;` +
        'width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;background:rgba(108,92,231,.55)';
      document.documentElement.appendChild(rp);
      rp.animate([{ transform: 'scale(.4)', opacity: 1 }, { transform: 'scale(3.2)', opacity: 0 }],
        { duration: 420, easing: 'ease-out' });
      return wait(280);
    },
    async moveToSel(sel, ms = 600) { const { x, y } = rectOf(sel); await this.move(x, y, ms); return { x, y }; },
    async clickSel(sel, ms = 550) {
      const { x, y } = await this.moveToSel(sel, ms);
      await this.pulse(x, y);
      const el = resolveEl(sel); el.click();
    },
    async typeInto(sel, text, cps = 38) {
      const { rect } = rectOf(sel);
      await this.move(rect.left + rect.width * 0.25, rect.top + rect.height / 2, 600);
      const el = resolveEl(sel);
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const set = Object.getOwnPropertyDescriptor(proto, 'value').set;
      const delay = Math.round(1000 / cps);
      for (let i = 1; i <= text.length; i++) {
        set.call(el, text.slice(0, i));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(delay);
      }
    },
    zoom(scale, ox, oy, ms = 800) {
      const el = document.documentElement;
      el.style.transformOrigin = `${ox}px ${oy}px`;
      el.style.transition = `transform ${ms}ms cubic-bezier(.4,0,.2,1)`;
      el.style.transform = `scale(${scale})`;
      return wait(ms + 40);
    },
    async zoomToSel(sel, scale = 1.3, ms = 850) { const { x, y } = rectOf(sel); await this.zoom(scale, x, y, ms); },
    reset(ms = 700) { return this.zoom(1, 0, 0, ms); },
  };
}
```

### `src/recorder.js`

The harness: launches Chromium with `recordVideo`, injects the kit, and exposes a
**Driver** with a declarative API that your script uses.

```js
import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cursorKit } from './cursor-kit.js';

// Optional: locate an installed headless-shell if node_modules/browser revisions
// mismatch (otherwise just rely on `npx playwright install chromium`).
function findExecutable() {
  const base = join(process.env.LOCALAPPDATA || process.env.HOME || '', 'ms-playwright');
  if (!existsSync(base)) return undefined;
  const dir = readdirSync(base).find((d) => d.startsWith('chromium_headless_shell'));
  if (!dir) return undefined;
  const p = join(base, dir, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
  return existsSync(p) ? p : undefined;
}

class Driver {
  constructor(page) { this.page = page; }
  goto(url, opts = {}) { return this.page.goto(url, { waitUntil: 'networkidle', ...opts }); }
  hold(ms) { return this.page.waitForTimeout(ms); }
  moveTo(sel, ms) { return this.page.evaluate(([s, m]) => window.__demo.moveToSel(s, m), [sel, ms]); }
  type(sel, text, cps) { return this.page.evaluate(([s, t, c]) => window.__demo.typeInto(s, t, c), [sel, text, cps]); }
  zoomTo(sel, scale, ms) { return this.page.evaluate(([s, sc, m]) => window.__demo.zoomToSel(s, sc, m), [sel, scale, ms]); }
  resetZoom(ms) { return this.page.evaluate((m) => window.__demo.reset(m), ms); }
  waitFor(selOrFn, opts = {}) {
    if (typeof selOrFn === 'function') return this.page.waitForFunction(selOrFn, undefined, { timeout: 20000, ...opts });
    return this.page.waitForSelector(selOrFn, { timeout: 20000, ...opts });
  }
  // Click with cursor move + pulse; pass {nav:true} for full-page navigation links.
  async click(sel, { nav = false, ms } = {}) {
    if (nav) {
      const { x, y } = await this.page.evaluate(([s, m]) => window.__demo.moveToSel(s, m), [sel, ms]);
      await this.page.evaluate(([x, y]) => window.__demo.pulse(x, y), [x, y]);
      await Promise.all([
        this.page.waitForNavigation({ waitUntil: 'networkidle' }),
        this.page.evaluate((s) => window.__demo.resolveEl(s).click(), sel),
      ]);
    } else {
      await this.page.evaluate(([s, m]) => window.__demo.clickSel(s, m), [sel, ms]);
    }
  }
}

export async function record(flow, {
  outDir = 'out', url, width = 1280, height = 800, scale = 2, headless = true,
} = {}) {
  const browser = await chromium.launch({ headless, executablePath: findExecutable() });
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: scale,
    recordVideo: { dir: outDir, size: { width, height } },
  });
  const page = await context.newPage();
  await page.addInitScript(cursorKit);
  const driver = new Driver(page);
  if (url) await driver.goto(url);
  try { await flow(driver, page); }
  finally {
    await context.close(); // finalizes the .webm
    const videoPath = await page.video()?.path();
    await browser.close();
    return videoPath;
  }
}
```

### `src/encode.js`

```js
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

const run = (args) => new Promise((res, rej) => {
  const p = spawn(ffmpegPath, args, { stdio: 'inherit' });
  p.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg exit ' + c))));
});

// webm -> mp4 (H.264). speed>1 trims idle (e.g. 1.25 = 25% faster).
export function toMp4(input, output, { fps = 30, speed = 1 } = {}) {
  const vf = speed !== 1 ? ['-vf', `setpts=${(1 / speed).toFixed(4)}*PTS`] : [];
  return run(['-y', '-i', input, ...vf, '-r', String(fps),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', output]);
}

// webm -> gif (palette for quality). Keep it short (a highlight, not 30s).
export async function toGif(input, output, { fps = 15, width = 960 } = {}) {
  const palette = output.replace(/\.gif$/, '') + '-palette.png';
  await run(['-y', '-i', input, '-vf', `fps=${fps},scale=${width}:-1:flags=lanczos,palettegen`, palette]);
  await run(['-y', '-i', input, '-i', palette,
    '-lavfi', `fps=${fps},scale=${width}:-1:flags=lanczos[x];[x][1:v]paletteuse`, output]);
}

// Extract a single frame for visual self-verification (Claude Code loop).
export function frameAt(input, t, output) {
  return run(['-y', '-ss', String(t), '-i', input, '-frames:v', '1', output]);
}
```

---

## 6. Writing a demo script

`scripts/record.mjs` — declarative, readable. Example (a widget in shadow DOM):

```js
import { record } from '../src/recorder.js';

const video = await record(async (d) => {
  await d.hold(800);
  // 'host >>> inner' pierces the open shadow root of the web component.
  await d.type('my-widget >>> textarea', 'Muéstrame las ventas por región.');
  await d.click('my-widget >>> button.send');
  await d.waitFor(() => !!document.querySelector('my-widget').shadowRoot.querySelector('table'));
  await d.hold(500);
  await d.zoomTo('my-widget', 1.3); await d.hold(1800); await d.resetZoom();
  await d.click('nav a[href="/dashboard"]', { nav: true });
  await d.waitFor('#dashboard canvas');
  await d.zoomTo('#dashboard canvas', 1.25); await d.hold(1500); await d.resetZoom();
}, { url: 'http://127.0.0.1:4317/', headless: true });

console.log('VIDEO:', video);
```

Run:

```bash
node examples/mock-server.mjs &   # if you use a mock backend (see §8)
node scripts/record.mjs
```

---

## 7. Using it from Claude Code (the key loop)

The way to iterate toward a fluid video **without watching it live** is the
**record → extract frames → look at them → adjust** loop. Ask Claude Code:

> "I have the app at `http://localhost:3000`. I want a video that: opens the chat,
> asks X, shows the result with zoom, and goes to the dashboard. Use
> `demo-recorder`."

Claude Code then:
1. **Writes** `scripts/record.mjs` with the Driver for that flow.
2. **Records**: `node scripts/record.mjs`.
3. **Extracts key frames** and **looks at them** (vision) to self-verify cursor,
   zoom, render and timing:
   ```bash
   node -e "import('./src/encode.js').then(m=>m.frameAt('out/video.webm', 3.5, 'out/f1.png'))"
   ```
   (or a mini-script that pulls several `frameAt`), and then opens the PNGs.
4. **Adjusts** delays/zoom/selectors and iterates 2.–3. until it's fluid.
5. **Encodes/publishes** (§9).

> This frame-by-frame self-verification loop is what makes it viable for an agent
> to fine-tune the video without manual intervention. Keep the `frameAt` calls at
> key moments (message send, block render, navigation click, final reveal).

---

## 8. Determinism: how to feed the app

For the script to be **repeatable**, the app must always respond the same way.

- **Static app / no dynamic backend**: point the recorder at your real app. Done.
- **App with endpoints/SSE (LLM chat, dashboards…)**: stand up a deterministic
  **mock backend**. Minimal pattern (SSE with incremental streaming + JSON endpoints):

```js
// examples/mock-server.mjs  — Node http, no frameworks.
import http from 'node:http';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sse = (res, ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);

http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/chat/stream')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=UTF-8',
      'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    for (const w of 'Aquí tienes el resumen de ventas por región.'.split(' ')) {
      sse(res, 'text', { delta: w + ' ' }); await sleep(55);   // incremental streaming
    }
    await sleep(400);
    sse(res, 'block', { type: 'table', data: { rows: [/* ... */] } });
    sse(res, 'done', {}); res.end(); return;
  }
  if (req.url.startsWith('/api/dashboard')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: { /* canned widgets */ } })); return;
  }
  // ...serve your HTML/app here, or use your real dev server for the chrome.
}).listen(4317);
```

Keys: **stream with `sleep` between chunks** (not `route.fulfill`), and serve your
app's **real bundles/HTML** so the chrome looks authentic. If your app has its own
dev server, you can also let most requests through and only intercept the
non-deterministic ones.

---

## 9. Publishing the video

- **GitHub README (the simplest):** upload the **`.webm`** by drag-drop in the
  README editor (or in an issue/PR and copy the `…/assets/…` URL). GitHub hosts it
  and plays it back inline. 10 MB limit in the web editor; a ~30s clip is around
  2–3 MB.
- **Outside GitHub / maximum compatibility:** encode to **mp4 H.264**
  (`toMp4`) and/or a short highlight **gif** (`toGif`).

---

## 10. Polish / improvements roadmap (for your plan)

Ideas ordered by value/effort:

- **Declarative script (YAML/JSON)** → a `demo.yml` with steps (`type`, `click`,
  `zoom`, `hold`, `waitFor`) that the recorder executes. Makes demos editable
  without touching JS and makes it easier for Claude Code to generate them.
- **Auto-zoom to clicked elements** (Screen Studio-style heuristic): on
  click/appearance of a block, smooth automatic zoom to its bounding box.
- **Captions/subtitles**: SRT synced with the steps → burn in with ffmpeg.
- **TTS voiceover** (ElevenLabs / OpenAI TTS) per step or from the SRT.
- **Idle-speedup**: automatically speed up the action-free stretches (fewer
  "dead times") — `setpts` per segment.
- **Intro/outro + branding**: composition layer (hyperframes/Remotion or an HTML
  rendered to frames) for title, logo, music.
- **CLI + config** (`demo-recorder record --config demo.yml --out out/`).
- **Multi-resolution / multi-theme** (light/dark) from the same script.
- **Robust "real app" mode**: login helper, selective `page.route` to pin only the
  non-deterministic parts while leaving the rest real.
- **Richer cursor**: states (idle/click/drag), subtle trail, keystroke highlight.

---

## 11. Quick gotchas reference (cheat sheet)

| Symptom | Cause | Fix |
|---|---|---|
| Streaming appears "all at once" | `route.fulfill` doesn't stream | SSE server with `sleep`, or client-side `ReadableStream` |
| `ffmpeg -vf fps=1` fails / no mp4 | Playwright's stripped ffmpeg | `ffmpeg-static`; frames with `-ss` |
| `chromium.launch` "Executable doesn't exist" | browser revision out of sync | `npx playwright install chromium` or `executablePath` |
| `fill` doesn't fire the component | listeners on native `input` | native setter + `dispatchEvent('input')` |
| Can't find the widget element | it's in shadow DOM | resolve `host >>> inner` |
| Blurry video | no HiDPI | `deviceScaleFactor: 2` |
| Zoom clips content | `transform-origin` misplaced | origin toward the side to preserve; lower the scale |

---

## 12. Effects layer — validated decisions (phases 1–2)

Most of the §10 roadmap is now implemented (richer cursor, intro/outro + branding, multi-format,
keystroke highlight, attention effects). Four decisions are worth recording so they aren't
re-litigated — full usage in [AESTHETICS.md](AESTHETICS.md):

1. **In-page overlays live on a counter-transformed layer, not on `documentElement`.** The camera
   zoom is a CSS `transform` on `<html>`, which also re-anchors fixed descendants. Spotlight,
   keycaps, callouts and the highlight sweep render on one fixed overlay whose transform is set each
   frame to the **inverse** of the live zoom matrix, so they stay in screen space and track elements
   mid-zoom. A ref-counted rAF loop keeps the counter-transform current only while something is
   showing (zero idle cost). The synthetic cursor stays on `documentElement` (unchanged).

2. **All burned text goes through libass, never `drawtext`.** The bundled `ffmpeg-static` (Linux
   build) omits `drawtext` (it needs libharfbuzz). So lower-thirds, watermark, intro/outro text and
   contact-sheet labels share one positioned-text path (`buildPosAss`/`buildAss`), with fonts staged
   next to the `.ass` and `fontsdir=.` + `cwd` to sidestep the Windows drive-colon in filter args.

3. **A `<video>.events.json` sidecar timestamps every visual beat.** Clicks/zooms/types/keycaps were
   previously untimed; `Driver.mark()` records them (same `t0` as the idle/captions sidecars). This
   one piece of infra unlocked step-synced SFX and lower-thirds, and is the hook for future
   event-driven post-pro (transitions, speed ramps). SFX/chapter times are shifted by the intro
   length when composing, exactly like the music envelope's `offset`.

4. **Match-cut is an `xfade` zoom-dissolve, not a geometric morph.** Aligning a logo to a real DOM
   element is fragile and expensive; instead the intro push-zooms and the intro→demo boundary is an
   `xfade` (audio `acrossfade`d too) computed from the real clip durations (`xfadeOffsets`). It gets
   ~80% of the "not pasted on" effect at a fraction of the cost. Intra-demo transitions and
   action-following smart-crop were deliberately deferred (they need splitting the continuous webm at
   event boundaries).
