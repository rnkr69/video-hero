# Blueprint — Herramienta de vídeos demo scripted (reusable)

> 🌐 [English](BLUEPRINT.md) · **Español**

> **Qué es esto:** todo lo necesario para montar, **desde cero y en una carpeta
> vacía**, una herramienta reutilizable que genera vídeos de producto fluidos y
> **deterministas** de cualquier web app, conducida por Playwright y orquestable
> desde **Claude Code**. Es el resultado validado de un piloto (P0/P1): incluye
> los aprendizajes, los *gotchas* y el código generalizado listo para copiar.
>
> Este documento es el punto de partida de un proyecto **independiente**. Muévelo
> a la carpeta nueva y empieza ahí el plan de pulido/uso/mejoras.

---

## 1. Concepto y decisiones validadas

**Problema:** grabar demos a mano (OBS) no sale "fluido" (jitter del ratón, timing
inconsistente, manual, no reproducible).

**Solución validada — pipeline:**

```
Fuente determinista (mock/canned)
        │
        ▼
Playwright recordVideo (píxeles reales: capta streaming, canvas, todo)
        │   + capa inyectada: cursor animado (easing) · typing char-a-char
        │     · pulse de click · auto-zoom de cámara (CSS transform)
        ▼
.webm  ──(ffmpeg real)──▶  .mp4 / .gif
```

**Por qué este enfoque (y no otros):**

- **No construir desde cero** lo difícil (cursor físico, auto-zoom, encoding):
  se reusan piezas robustas (Playwright + ffmpeg) y solo se escribe la **capa
  fina** de coreografía.
- **`playwright-recast`** (la herramienta OSS más cercana) se **descartó**: v0.1.0,
  zoom/captions aún no implementados, y **reconstruye desde el trace** (snapshots
  del DOM) en vez de píxeles reales → peor fidelidad con canvas/streaming.
- **`recordVideo` de Playwright** graba **píxeles reales** → canvas (Chart.js),
  streaming de tokens, animaciones CSS… todo sale fiel.
- **Determinista por diseño**: respuestas/timing fijos → el guión es **repetible**
  (sin tomas flaky, sin esperar a un LLM, sin tokens, re-renderizable en CI).

---

## 2. Gotchas críticos (no re-descubrir)

1. **Playwright `route.fulfill()` NO hace streaming**: entrega el body de una vez.
   Si tu app usa SSE/streaming (chat LLM, etc.) y quieres ver el efecto incremental,
   **no** lo mockees con `route.fulfill`. Usa una de estas dos fuentes:
   - **Servidor SSE propio** que emite chunks con `await sleep()` entre ellos
     (recomendado; ver `examples/mock-server.mjs`).
   - **Mock client-side** con un `ReadableStream` que hace `enqueue` con delays.
2. **El ffmpeg que trae Playwright es un build recortado**: solo VP8 (para mux del
   screencast), **sin H.264/GIF** y con el **parser de filtros roto** (`-vf fps=1`
   falla). Para encodear a mp4/gif usa un ffmpeg **real** → paquete npm
   `ffmpeg-static` (descarga un binario completo, sin compilar nada nativo).
3. **Extraer frames para auto-verificación**: con cualquier ffmpeg, lo más robusto
   es seek por timestamp: `ffmpeg -ss <t> -i in.webm -frames:v 1 frame.png`
   (evita `-vf fps=1`).
4. **Browser revision mismatch**: si `node_modules` quedó instalado por otra versión
   de Playwright que la del caché de navegadores, `chromium.launch()` falla. Solución
   limpia: `npx playwright install chromium`. Workaround sin descargar: pasar
   `executablePath` al binario instalado (ver `src/recorder.js`).
5. **Shadow DOM**: muchos widgets (web components) viven en shadow root. Para
   conducirlos: resolver `host >>> inner` y, para escribir en `<textarea>`/`<input>`
   de un custom element, usar el **native setter** + `dispatchEvent('input')`
   (un `fill` normal puede no disparar los listeners del componente).
6. **Esperar "fin de streaming"**: detéctalo por DOM (p.ej. botón de envío
   re-habilitado, ausencia de cursor de streaming, aparición del bloque final).
7. **Calidad**: `deviceScaleFactor: 2` + `recordVideo.size` al tamaño del viewport
   → vídeo nítido.
8. **README en GitHub**: GitHub reproduce **webm/mp4/mov** subidos por drag-drop
   (límite 10 MB en el editor web). No necesitas encodear para publicar; el webm
   vale. (mp4 H.264 es lo más universal si lo quieres fuera de GitHub.)

---

## 3. Requisitos

- **Node 20+**.
- **Playwright** + navegador Chromium (`npx playwright install chromium`).
- **ffmpeg-static** (solo si quieres mp4/gif; para webm no hace falta).
- Tu **web app corriendo** en una URL local (real), **o** una **página/servidor
  mock determinista** (recomendado para apps con LLM/streaming).

---

## 4. Bootstrap desde cero

```bash
mkdir demo-recorder && cd demo-recorder
npm init -y
npm pkg set type=module
npm i -D playwright ffmpeg-static
npx playwright install chromium
mkdir -p src scripts examples out
```

Estructura objetivo:

```
demo-recorder/
├─ package.json
├─ src/
│  ├─ cursor-kit.js     # inyectado en la página: cursor + zoom + helpers
│  ├─ recorder.js       # harness: lanza chromium, graba, API de "Driver"
│  └─ encode.js         # webm -> mp4 / gif (ffmpeg-static)
├─ examples/
│  └─ mock-server.mjs   # backend mock determinista (apps con SSE/endpoints)
├─ scripts/
│  └─ record.mjs        # TU guión de demo (usa el Driver)
└─ out/                 # vídeos + frames extraídos
```

---

## 5. Código reusable

### `src/cursor-kit.js`

Se inyecta con `addInitScript` y vive **dentro de la página** como `window.__demo`.
Incluye el cursor sintético, el zoom de cámara y los helpers de shadow DOM/typing.

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

El harness: lanza Chromium con `recordVideo`, inyecta el kit, y expone un **Driver**
con una API declarativa que tu guión usa.

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

## 6. Escribir un guión de demo

`scripts/record.mjs` — declarativo, legible. Ejemplo (un widget en shadow DOM):

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

Ejecutar:

```bash
node examples/mock-server.mjs &   # si usas backend mock (ver §8)
node scripts/record.mjs
```

---

## 7. Usarlo desde Claude Code (el loop clave)

La forma de iterar a un vídeo fluido **sin verlo en directo** es el bucle
**grabar → extraer frames → mirarlos → ajustar**. Pídele a Claude Code:

> "Tengo la app en `http://localhost:3000`. Quiero un vídeo que: abra el chat,
> pregunte X, muestre el resultado con zoom, y vaya al dashboard. Usa
> `demo-recorder`."

Claude Code entonces:
1. **Escribe** `scripts/record.mjs` con el Driver para ese flujo.
2. **Graba**: `node scripts/record.mjs`.
3. **Extrae frames clave** y **los mira** (visión) para auto-verificar cursor,
   zoom, render y timing:
   ```bash
   node -e "import('./src/encode.js').then(m=>m.frameAt('out/video.webm', 3.5, 'out/f1.png'))"
   ```
   (o un mini-script que saque varios `frameAt`), y luego abre los PNG.
4. **Ajusta** delays/zoom/selectores e itera 2.–3. hasta que quede fluido.
5. **Encodea/publica** (§9).

> Este bucle de auto-verificación por frames es lo que hace viable que un agente
> afine el vídeo sin intervención manual. Mantén los `frameAt` en momentos clave
> (envío del mensaje, render del bloque, click de navegación, reveal final).

---

## 8. Determinismo: cómo alimentar la app

Para que el guión sea **repetible**, la app debe responder igual siempre.

- **App estática / sin backend dinámico**: apunta el recorder a tu app real. Listo.
- **App con endpoints/SSE (chat LLM, dashboards…)**: levanta un **mock backend**
  determinista. Patrón mínimo (SSE con streaming incremental + endpoints JSON):

```js
// examples/mock-server.mjs  — Node http, sin frameworks.
import http from 'node:http';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sse = (res, ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);

http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/chat/stream')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=UTF-8',
      'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    for (const w of 'Aquí tienes el resumen de ventas por región.'.split(' ')) {
      sse(res, 'text', { delta: w + ' ' }); await sleep(55);   // streaming incremental
    }
    await sleep(400);
    sse(res, 'block', { type: 'table', data: { rows: [/* ... */] } });
    sse(res, 'done', {}); res.end(); return;
  }
  if (req.url.startsWith('/api/dashboard')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: { /* widgets canned */ } })); return;
  }
  // ...sirve tu HTML/app aquí, o usa tu dev server real para el chrome.
}).listen(4317);
```

Claves: **streaming con `sleep` entre chunks** (no `route.fulfill`), y servir los
**bundles/HTML reales** de tu app para que el chrome se vea auténtico. Si tu app
tiene su propio dev server, también puedes dejar pasar la mayoría de requests y
solo interceptar los no-deterministas.

---

## 9. Publicar el vídeo

- **GitHub README (lo más simple):** sube el **`.webm`** por drag-drop en el editor
  del README (o en un issue/PR y copia la URL `…/assets/…`). GitHub lo hostea y lo
  reproduce inline. Límite 10 MB en el editor web; un clip de ~30s ronda 2–3 MB.
- **Fuera de GitHub / máxima compatibilidad:** encodea a **mp4 H.264**
  (`toMp4`) y/o un **gif** corto de highlight (`toGif`).

---

## 10. Roadmap de pulido / mejoras (para tu plan)

Ideas ordenadas por valor/esfuerzo:

- **Guión declarativo (YAML/JSON)** → un `demo.yml` con pasos (`type`, `click`,
  `zoom`, `hold`, `waitFor`) que el recorder ejecuta. Hace los demos editables sin
  tocar JS y facilita que Claude Code los genere.
- **Auto-zoom a elementos clicados** (heurística estilo Screen Studio): al hacer
  click/aparecer un bloque, zoom suave automático a su bounding box.
- **Captions/subtítulos**: SRT sincronizado con los pasos → quemar con ffmpeg.
- **Voiceover TTS** (ElevenLabs / OpenAI TTS) por paso o desde el SRT.
- **Idle-speedup**: acelerar automáticamente los tramos sin acción (menos
  "tiempos muertos") — `setpts` por segmentos.
- **Intro/outro + marca**: capa de composición (hyperframes/Remotion o un HTML
  renderizado a frames) para título, logo, música.
- **CLI + config** (`demo-recorder record --config demo.yml --out out/`).
- **Multi-resolución / multi-tema** (claro/oscuro) desde el mismo guión.
- **Modo "real app"** robusto: login helper, `page.route` selectivo para fijar solo
  lo no-determinista dejando el resto real.
- **Cursor más rico**: estados (idle/click/drag), trail sutil, resaltado de tecleo.

---

## 11. Referencia rápida de gotchas (chuleta)

| Síntoma | Causa | Fix |
|---|---|---|
| El streaming aparece "de golpe" | `route.fulfill` no streamea | Servidor SSE con `sleep`, o `ReadableStream` client-side |
| `ffmpeg -vf fps=1` falla / no hay mp4 | ffmpeg de Playwright recortado | `ffmpeg-static`; frames con `-ss` |
| `chromium.launch` "Executable doesn't exist" | revisión de navegador desfasada | `npx playwright install chromium` o `executablePath` |
| `fill` no dispara el componente | listeners sobre `input` nativo | native setter + `dispatchEvent('input')` |
| No encuentra el elemento del widget | está en shadow DOM | resolver `host >>> inner` |
| Vídeo borroso | sin HiDPI | `deviceScaleFactor: 2` |
| Zoom recorta contenido | `transform-origin` mal puesto | origen hacia el lado a conservar; baja la escala |

---

## 12. Capa de efectos — decisiones validadas (fases 1–2)

La mayor parte del roadmap del §10 ya está implementada (cursor más rico, intro/outro + marca,
multi-formato, resaltado de tecleo, efectos de atención). Cuatro decisiones merecen quedar
registradas para no re-litigarlas — el uso completo está en [MEJORAS_ESTETICAS.md](MEJORAS_ESTETICAS.md):

1. **Los overlays in-page viven en una capa contra-transformada, no en `documentElement`.** El zoom
   de cámara es un `transform` CSS sobre `<html>`, que además re-ancla los descendientes fixed. La
   máscara de atención (spotlight), las keycaps, los callouts y el barrido de resaltado se renderizan
   sobre un único overlay fixed cuya transform se fija en cada frame a la **inversa** de la matriz de
   zoom en vivo, así se quedan en espacio de pantalla y siguen los elementos a mitad de zoom. Un loop
   rAF con conteo de referencias mantiene la contra-transform al día solo mientras algo está visible
   (coste cero en reposo). El cursor sintético se queda en `documentElement` (sin cambios).

2. **Todo el texto quemado pasa por libass, nunca por `drawtext`.** El `ffmpeg-static` empacado (build
   de Linux) omite `drawtext` (necesita libharfbuzz). Así que lower-thirds, watermark, texto de
   intro/outro y etiquetas del contact-sheet comparten una única ruta de texto posicionado
   (`buildPosAss`/`buildAss`), con las fuentes preparadas junto al `.ass` y `fontsdir=.` + `cwd` para
   sortear el dos-puntos de unidad de Windows en los args de filtro.

3. **Un sidecar `<video>.events.json` marca el timestamp de cada beat visual.** Clicks/zooms/types/
   keycaps antes no estaban temporizados; `Driver.mark()` los registra (mismo `t0` que los sidecars
   idle/captions). Esta única pieza de infra desbloqueó los SFX sincronizados con los pasos y los
   lower-thirds, y es el gancho para futura post-pro guiada por eventos (transiciones, rampas de
   velocidad). Los tiempos de SFX/capítulos se desplazan por la duración de la intro al componer,
   exactamente como el `offset` de la envolvente de música.

4. **El match-cut es un zoom-disolvencia `xfade`, no un morph geométrico.** Alinear un logo a un
   elemento real del DOM es frágil y caro; en su lugar la intro hace un push-zoom y el límite
   intro→demo es un `xfade` (con el audio también en `acrossfade`) calculado a partir de las
   duraciones reales de los clips (`xfadeOffsets`). Consigue ~80% del efecto "no está pegado" a una
   fracción del coste. Las transiciones intra-demo y el smart-crop que sigue la acción se aplazaron
   deliberadamente (necesitan partir el webm continuo en los límites de evento).
