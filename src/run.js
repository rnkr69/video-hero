// src/run.js — run a declarative YAML/JSON demo script. Thin layer over Driver/record;
// it adds no recording logic of its own, just maps steps to Driver calls.
//
//   node src/run.js examples/demo.yml      (o, instalado como CLI:  demo-recorder run …)
//
// Selector note:
//   - click / move / type / zoomTo / zoomFit go through the in-page kit → use the custom
//     `host >>> inner` syntax to pierce shadow DOM.
//   - waitFor goes through Playwright → use Playwright CSS (it pierces OPEN shadow roots
//     automatically, e.g. `demo-chat table`).
import { readFileSync, existsSync, readdirSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { record, saveAuth, openSession } from './recorder.js';
import {
  toMp4, toGif, speedupIdle, writeSrt, burnSubs,
  buildIntroFfmpeg, concatVideos, probeSize, probeDuration, addMusicBed, toMp4Silent,
} from './encode.js';
import { narrateVideo, getNarration, musicEnvelope } from './tts.js';
import { rawDir, workDir, ensureDir, pruneRaw, wipeWork } from './layout.js';
import { resolveTrack } from './tracks.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// Substitute ${ENV_VAR} in every string of the spec — for real-app URLs, tokens and
// credentials (keep secrets out of the YAML and in the environment).
const subEnv = (v) => {
  if (typeof v === 'string') return v.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? '');
  if (Array.isArray(v)) return v.map(subEnv);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subEnv(x)]));
  return v;
};

const loadSpec = (file) => subEnv(parse(readFileSync(resolve(file), 'utf8')) || {});
const norm = (arg) => (typeof arg === 'string' ? { sel: arg } : arg || {});

// Map a spec to openSession/record options.
const sessionOpts = (spec) => ({
  outDir: spec.out || 'out', width: spec.width, height: spec.height, scale: spec.scale,
  headless: spec.headless, autoZoom: spec.autoZoom, storageState: spec.storageState,
  routes: spec.route, waitTimeout: spec.waitTimeout,
});

// 1-based inclusive sub-range of steps (for iterating one beat). Combine with `route`
// mocks / a leading `goto` so earlier state the range depends on is cheap to re-create.
const sliceSteps = (steps, from, to) =>
  (from == null && to == null) ? steps : steps.slice(from != null ? from - 1 : 0, to != null ? to : steps.length);

async function runStep(d, step) {
  const entries = Object.entries(step);
  if (entries.length !== 1) throw new Error('each step must have exactly one action key: ' + JSON.stringify(step));
  const [action, arg] = entries[0];
  switch (action) {
    case 'goto':      { const o = norm(arg); return d.goto(o.sel || o.url, o.opts || {}); }
    case 'hold':      return d.hold(Number(arg));
    case 'move':      { const o = norm(arg); return d.moveTo(o.sel, o.ms); }
    case 'type':      { const o = norm(arg); return d.type(o.sel, o.text, o.cps); }
    case 'click':     { const o = norm(arg); return d.click(o.sel, { nav: !!o.nav, ms: o.ms, zoom: o.zoom }); }
    case 'zoomTo':    { const o = norm(arg); return d.zoomTo(o.sel, o.scale, o.ms); }
    case 'zoomFit':   { const { sel, ...opts } = norm(arg); return d.zoomToFit(sel, opts); }
    case 'resetZoom': return d.resetZoom(typeof arg === 'number' ? arg : undefined);
    case 'caption':   return d.caption(typeof arg === 'string' ? arg : (arg && arg.text));
    case 'waitFor':   { const o = norm(arg); return d.waitFor(o.sel, o.opts || {}); }
    default:          throw new Error('unknown step action: ' + action);
  }
}

// ---- Environment preflight (catch the classic traps cheaply) ---------------

function preflight(spec) {
  if (!spec.url) return;
  let host;
  try { host = new URL(spec.url).host; } catch { return; }
  const appUrl = process.env.APP_URL;
  if (appUrl) {
    let ah; try { ah = new URL(appUrl).host; } catch { /* ignore */ }
    if (ah && ah !== host) {
      const cookieTrap = ah.replace('127.0.0.1', 'localhost') === host.replace('127.0.0.1', 'localhost');
      console.warn(`[preflight] OJO: url (${host}) ≠ APP_URL (${ah}).` +
        (cookieTrap ? ' Es la trampa 127.0.0.1↔localhost: las cookies/CSRF (Laravel, etc.) no casarán. Usa el MISMO host.'
                    : ' Cookies/CSRF/redirecciones pueden fallar.'));
    }
  }
}

async function postNav(page, spec) {
  try {
    const landed = new URL(page.url());
    const requested = new URL(spec.url);
    if (landed.host !== requested.host) {
      console.warn(`[preflight] redirigido a otro host: pediste ${requested.host}, estás en ${landed.host}.`);
    }
    if (spec.storageState && /log[-_ ]?in|sign[-_ ]?in|auth/i.test(landed.pathname)) {
      console.warn(`[preflight] parece pantalla de login (${landed.pathname}) pese a storageState: ` +
        '¿sesión caducada? Regenérala: demo-recorder login <guion.yml>');
    }
  } catch { /* ignore */ }
}

// ---- Login ------------------------------------------------------------------

async function doLogin(spec) {
  const out = spec.storageState || 'auth.json';
  await saveAuth(async (d) => {
    for (const step of (spec.login.steps || [])) await runStep(d, step);
  }, { url: spec.login.url || spec.url, out, headless: spec.login.headless ?? false });
  return out;
}

export async function runLogin(file) {
  const spec = loadSpec(file);
  if (!spec.login) throw new Error('el guión no tiene bloque `login`');
  console.log('LOGIN: creando sesión →', spec.storageState || 'auth.json');
  return doLogin(spec);
}

// ---- Encode (decoupled from record so iteration stays fast) -----------------

// Render the intro HTML template (assets/intro.html) with the same Playwright engine, then
// transcode to mp4 WITH a silent audio track (Playwright records video-only; the silent track
// keeps the demo's audio alive through the concat). Richer CSS animation than the ffmpeg card.
async function recordIntroHtml(intro, spec) {
  const tpl = pathToFileURL(resolve(HERE, '../assets/intro.html')).href;
  const params = new URLSearchParams();
  if (intro.title) params.set('title', intro.title);
  if (intro.subtitle) params.set('subtitle', intro.subtitle);
  if (intro.bg) params.set('bg', intro.bg);
  if (intro.fg) params.set('fg', intro.fg);
  if (intro.logo) params.set('logo', pathToFileURL(resolve(intro.logo)).href);
  const url = `${tpl}?${params.toString()}`;

  const webm = await record(async (d) => { await d.hold((intro.duration ?? 2.8) * 1000); }, {
    outDir: spec.out || 'out', width: spec.width, height: spec.height, scale: spec.scale,
    headless: spec.headless ?? true, url,
  });
  const introMp4 = resolve(intro.out || join(ensureDir(workDir(spec.out)), 'intro.mp4'));
  await toMp4Silent(webm, introMp4);
  return introMp4;
}

// Build the intro CLIP (silent video card), sized to the target video. ffmpeg card by default,
// or the recorded HTML template. The clip is an intermediate (→ work/); audio is added later as
// one continuous bed over intro+demo.
async function buildIntroClip(spec, intro, target) {
  if ((intro.engine || 'ffmpeg') === 'html') return recordIntroHtml(intro, spec);
  const size = await probeSize(target);
  const introMp4 = resolve(intro.out || join(ensureDir(workDir(spec.out)), 'intro.mp4'));
  const music = intro.music ? resolveTrack(intro.music) : undefined; // bundled name/alias or path
  await buildIntroFfmpeg({ ...intro, music, out: introMp4, width: size.w, height: size.h });
  return introMp4;
}

async function applyEncode(spec, video) {
  const e = spec.encode;
  if (!e) return;
  // Make sure every configured output's parent dir exists (e.g. out/work/ for intermediates).
  [e.srt, e.captionsMp4, e.narrateMp4, e.idleMp4, e.mp4, e.gif, e.intro?.result, e.intro?.out, e.music?.out]
    .forEach((p) => { if (p) ensureDir(dirname(resolve(p))); });
  if (e.srt) { await writeSrt(video, e.srt); console.log('SRT:', e.srt); }
  if (e.captionsMp4) { await burnSubs(video, e.captionsMp4, e.captionsOpts || {}); console.log('CAPTIONS MP4:', e.captionsMp4); }
  // `music: true` (or any truthy non-object) → bundled default track with default ducking.
  let music = e.music || (e.ttsOpts || {}).music;
  if (music && typeof music !== 'object') music = {};
  if (e.narrateMp4) {
    // Voice over the captioned video if subs were burned, else over the clean video (= "vídeo
    // + audio SIN subs": `caption:` steps still drive the voice via `<video>.captions.json`,
    // they're just not rendered). NOTE: music is NOT mixed here — it's laid as one continuous
    // bed in the final stage below, so it can also span a prepended intro.
    const src = e.captionsMp4 || video;
    await narrateVideo(src, e.narrateMp4, { ...(e.ttsOpts || {}), music: undefined, captionsFrom: video });
    console.log('NARRATE MP4:', e.narrateMp4);
  }
  if (e.idleMp4) { await speedupIdle(video, e.idleMp4, e.idleOpts || {}); console.log('IDLE MP4:', e.idleMp4); }
  if (e.mp4) { await toMp4(video, e.mp4, e.mp4opts || {}); console.log('MP4:', e.mp4); }
  if (e.gif) { await toGif(video, e.gif, e.gifopts || {}); console.log('GIF:', e.gif); }

  // ---- Final composition: prepend intro, then lay ONE continuous music bed over everything.
  if (e.intro || music) {
    // The finished demo to build on: explicit prependTo, else the last meaningful output.
    let target = resolve(e.intro?.prependTo || e.narrateMp4 || e.captionsMp4 || e.idleMp4 || e.mp4 || video);
    let introDur = 0;

    const work = () => ensureDir(workDir(spec.out));
    const tmpIn = (p, tag) => join(work(), basename(p).replace(/\.(\w+)$/, `.${tag}.$1`));

    if (e.intro) {
      const introMp4 = await buildIntroClip(spec, e.intro, target);
      introDur = await probeDuration(introMp4);
      const result = resolve(e.intro.result || target.replace(/\.(\w+)$/, '-intro.$1'));
      // If music follows, concat to a work/ temp; the music stage writes the final `result`.
      const concatOut = music ? tmpIn(result, 'novol') : result;
      await concatVideos([introMp4, target], concatOut);
      if (!e.intro.out) { try { unlinkSync(introMp4); } catch { /* drop the intro clip intermediate */ } }
      target = concatOut;
      if (!music) console.log('INTRO:', result);
      e.intro._result = result; // stash the final name for the music stage
    }

    if (music) {
      const track = resolveTrack(music.track || music.path); // path, bundled name/alias, or default
      const dur = await probeDuration(target);
      // Voice timings come from the demo's captions; shift them by the intro length.
      const narration = e.narrateMp4 ? await getNarration(video, { ...(e.ttsOpts || {}), captionsFrom: video }) : [];
      const keyframes = musicEnvelope(narration, dur, music, introDur);
      // Final filename: the intro result (if any), else the narrate/target file (overwritten).
      const finalOut = resolve(e.intro ? e.intro._result : (music.out || target));
      // ffmpeg can't read+write the same file → bounce through a work/ temp, then rename into place.
      const tmp = tmpIn(finalOut, 'mtmp');
      await addMusicBed(target, tmp, { path: track, keyframes, duration: dur, fadeIn: music.fadeIn, fadeOut: music.fadeOut });
      if (e.intro) { try { unlinkSync(target); } catch { /* drop the temp concat */ } } // target is the work/ .novol temp
      renameSync(tmp, finalOut);
      console.log(e.intro ? 'INTRO+MUSIC:' : 'MUSIC:', finalOut);
    }
  }
}

const newestWebm = (dir) => {
  let best = null, bestT = -1;
  for (const d of [rawDir(dir), dir]) { // prefer out/raw/, fall back to out/ root (legacy webms)
    try {
      for (const f of readdirSync(d)) {
        if (!f.endsWith('.webm')) continue;
        const p = join(d, f); const t = statSync(p).mtimeMs;
        if (t > bestT) { bestT = t; best = resolve(p); }
      }
    } catch { /* ignore */ }
  }
  return best;
};

// Apply only the encode block of a spec to an existing webm (the newest in out/ if omitted).
export async function encodeOnly(file, webm) {
  const spec = loadSpec(file);
  if (!spec.encode) throw new Error('el guión no tiene bloque `encode`');
  const video = webm ? resolve(webm) : newestWebm(spec.out || 'out');
  if (!video) throw new Error('no encuentro ningún .webm; pásalo explícito: demo-recorder encode <yml> <webm>');
  console.log('ENCODE sobre:', video);
  await applyEncode(spec, video);
  wipeWork(spec.out || 'out'); // drop intermediates (out/work/)
  return video;
}

// ---- Record -----------------------------------------------------------------

export async function runScript(file, { encode = true, from, to } = {}) {
  const spec = loadSpec(file);
  preflight(spec);
  const steps = sliceSteps(spec.steps || [], from, to);

  if (spec.storageState && spec.login && !existsSync(spec.storageState)) {
    console.log('LOGIN: creando sesión →', spec.storageState);
    await doLogin(spec);
  }

  const video = await record(async (d) => {
    for (const step of steps) await runStep(d, step);
  }, { ...sessionOpts(spec), url: spec.url, onGoto: (page) => postNav(page, spec) });
  console.log('VIDEO:', video);

  if (encode) { await applyEncode(spec, video); wipeWork(spec.out || 'out'); } // drop intermediates
  pruneRaw(spec.out || 'out', spec.keepRaw ?? 3); // keep the last few recordings, drop older ones
  return video;
}

// ---- Probe (dry-run, headed, no recording, fail-fast diagnostics) -----------

// These run in the browser; keep them self-contained.
function browserDescribeChain(sel) {
  const parts = sel.split('>>>').map((s) => s.trim());
  const out = [];
  let el = document.querySelector(parts[0]);
  out.push(`'${parts[0]}': ${el ? 'OK' : 'NO ENCONTRADO'}` +
    (el ? (el.shadowRoot ? ' (tiene shadowRoot)' : ' (sin shadowRoot)') : ''));
  for (let i = 1; i < parts.length; i++) {
    if (!el) { out.push(`'${parts[i]}': (no evaluado: el anterior falló)`); break; }
    const root = el.shadowRoot || el;
    const next = root.querySelector(parts[i]);
    out.push(`'${parts[i]}': ${next ? 'OK' : 'NO ENCONTRADO'}`);
    if (!next) {
      const kids = [...root.children].slice(0, 25).map((c) => {
        const cls = (typeof c.className === 'string' && c.className.trim())
          ? '.' + c.className.trim().split(/\s+/).join('.') : '';
        return c.tagName.toLowerCase() + (c.id ? '#' + c.id : '') + cls;
      });
      out.push('  hijos de donde buscaba: ' + (kids.join(', ') || '(ninguno)'));
      break;
    }
    el = next;
  }
  return out.join('\n');
}
function browserCount(sel) {
  try { return `selector Playwright '${sel}': ${document.querySelectorAll(sel).length} coincidencia(s) ahora`; }
  catch (e) { return `selector '${sel}' inválido como CSS: ${e.message}`; }
}
function browserOutline() {
  const els = [...document.querySelectorAll('button,a[href],input,textarea,select,[role=button]')]
    .filter((e) => e.offsetParent !== null).slice(0, 30);
  return els.map((e) => {
    const t = (e.innerText || e.value || e.getAttribute('placeholder') || '').trim().slice(0, 30);
    const cls = (typeof e.className === 'string' && e.className.trim())
      ? '.' + e.className.trim().split(/\s+/).join('.') : '';
    return e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + cls + (t ? ` "${t}"` : '');
  }).join('\n') || '(ninguno visible)';
}

const describeStep = (step) => { const [a, v] = Object.entries(step)[0]; return `${a}: ${typeof v === 'string' ? v : JSON.stringify(v)}`; };

async function diagnose(page, action, arg) {
  const sel = (typeof arg === 'string') ? arg : (arg && (arg.sel || arg.url));
  const lines = [`URL: ${page.url()}`];
  try { lines.push(`título: ${await page.title()}`); } catch { /* ignore */ }
  if (sel && ['type', 'click', 'move', 'zoomTo', 'zoomFit'].includes(action)) {
    const c = await page.evaluate(browserDescribeChain, sel).catch(() => null);
    if (c) lines.push('selector (kit `>>>`):\n' + c);
  } else if (sel && action === 'waitFor') {
    const c = await page.evaluate(browserCount, sel).catch(() => null);
    if (c) lines.push(c);
  }
  const o = await page.evaluate(browserOutline).catch(() => null);
  if (o) lines.push('elementos interactivos visibles:\n' + o);
  return lines.join('\n');
}

// Dry-run the steps headed, fast, no recording/encoding. Stops at the first failing step
// and dumps why + DOM diagnostics. The fastest way to nail selector/waitFor/auth gotchas.
export async function probeScript(file, { from, to } = {}) {
  const spec = loadSpec(file);
  preflight(spec);
  const steps = sliceSteps(spec.steps || [], from, to);
  const base = from != null ? from : 1;

  if (spec.storageState && spec.login && !existsSync(spec.storageState)) {
    console.log('LOGIN: creando sesión →', spec.storageState);
    await doLogin(spec);
  }

  const session = await openSession({
    ...sessionOpts(spec), headless: false, recordVideo: false,
    waitTimeout: spec.probeTimeout || spec.waitTimeout || 10000, // fail fast on bad waitFor
  });
  const { browser, context, page, driver } = session;
  let ok = true;
  try {
    if (spec.url) { await driver.goto(spec.url); await postNav(page, spec); }
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const [action, arg] = Object.entries(step)[0];
      try {
        await runStep(driver, step);
        console.log(`  ok ${base + i}: ${describeStep(step)}`);
      } catch (e) {
        ok = false;
        console.error(`\n✗ FALLA en el paso ${base + i}: ${describeStep(step)}`);
        console.error(`  motivo: ${e.message}\n`);
        console.error(await diagnose(page, action, arg));
        break;
      }
    }
  } finally {
    if (!ok) { console.error('\n[probe] navegador abierto 15s para inspección…'); await page.waitForTimeout(15000); }
    await context.close(); await browser.close();
  }
  if (ok) console.log(`\n✓ probe OK — ${steps.length} paso(s) pasaron`);
  return ok;
}

// Pure helpers exposed ONLY for unit tests (not part of the public API).
export const __test = { subEnv, sliceSteps, norm, sessionOpts, preflight };

// CLI guard: `node src/run.js <guion.yml>` still works standalone.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node src/run.js <guion.yml|guion.json>'); process.exit(1); }
  runScript(file).catch((err) => { console.error(err.message); process.exit(1); });
}
