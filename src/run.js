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
import { readFileSync, existsSync, readdirSync, statSync, renameSync, unlinkSync, realpathSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { record, saveAuth, openSession } from './recorder.js';
import {
  toMp4, toGif, speedupIdle, writeSrt, burnSubs,
  buildIntroFfmpeg, concatVideos, probeSize, probeDuration, addMusicBed, toMp4Silent,
  reframe, mapSfx, muxSfx, burnWatermark, burnLowerThirds, xfadeJoin,
  applySpeedSegments, buildSpeedPlan, transitionAtCuts, addProgressBar, colorGrade,
  burnKaraoke, smartReframe,
} from './encode.js';
import { narrateVideo, getNarration, musicEnvelope } from './tts.js';
import { rawDir, workDir, ensureDir, pruneRaw, wipeWork } from './layout.js';
import { resolveTrack, resolveSfx } from './tracks.js';
import { applyCapture } from './capture.js';

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
  routes: spec.route, waitTimeout: spec.waitTimeout, capture: spec.capture,
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
    case 'move':      { const { sel, ms, ...o } = norm(arg); return d.moveTo(sel, ms, o); }
    case 'type':      { const o = norm(arg); return d.type(o.sel, o.text, o.cps); }
    case 'click':     { const o = norm(arg); return d.click(o.sel, { nav: !!o.nav, ms: o.ms, zoom: o.zoom, variant: o.variant, ripple: o.ripple, pop: o.pop }); }
    case 'zoomTo':    { const o = norm(arg); return d.zoomTo(o.sel, o.scale, o.ms); }
    case 'zoomFit':   { const { sel, ...opts } = norm(arg); return d.zoomToFit(sel, opts); }
    case 'resetZoom': return d.resetZoom(typeof arg === 'number' ? arg : undefined);
    case 'spotlight': { const { sel, ...o } = norm(arg); return d.spotlight(sel, o); }
    case 'spotlightOff': return d.spotlightOff();
    case 'key':
    case 'keycap':    return d.keycap(typeof arg === 'string' ? arg : (arg && (arg.label || arg.text)), (arg && typeof arg === 'object') ? arg : {});
    case 'scroll':    { const { sel, ...o } = norm(arg); return d.scrollTo(sel, o); }
    case 'annotate':  { const { sel, ...o } = norm(arg); return d.annotate(sel, o); }
    case 'annotateOff': return d.annotateOff();
    case 'highlight': { const { sel, ...o } = norm(arg); return d.highlight(sel, o); }
    case 'chapter':   return d.chapter(typeof arg === 'string' ? arg : (arg && arg.text));
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
  if (intro.accent) params.set('accent', intro.accent);
  if (intro.template) params.set('template', intro.template); // minimal | bold | terminal | mesh
  if (intro.typewriter) params.set('typewriter', '1');
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

// Render the OUTRO end-card (mirror of the intro): an animated CSS card (assets/outro.html) with a
// CTA + repo URL, transcoded to mp4 with a silent track so it concatenates after the demo. The
// ffmpeg engine reuses buildIntroFfmpeg (a generic card). Audio is added later as one continuous bed.
async function recordOutroHtml(outro, spec) {
  const tpl = pathToFileURL(resolve(HERE, '../assets/outro.html')).href;
  const params = new URLSearchParams();
  for (const k of ['title', 'subtitle', 'cta', 'url', 'bg', 'fg']) {
    if (outro[k]) params.set(k, outro[k]);
  }
  if (outro.logo) params.set('logo', pathToFileURL(resolve(outro.logo)).href);
  const url = `${tpl}?${params.toString()}`;
  const webm = await record(async (d) => { await d.hold((outro.duration ?? 3.0) * 1000); }, {
    outDir: spec.out || 'out', width: spec.width, height: spec.height, scale: spec.scale,
    headless: spec.headless ?? true, url,
  });
  const outroMp4 = resolve(outro.out || join(ensureDir(workDir(spec.out)), 'outro.mp4'));
  await toMp4Silent(webm, outroMp4);
  return outroMp4;
}

async function buildOutroClip(spec, outro, target) {
  if ((outro.engine || 'html') === 'html') return recordOutroHtml(outro, spec);
  const size = await probeSize(target);
  const outroMp4 = resolve(outro.out || join(ensureDir(workDir(spec.out)), 'outro.mp4'));
  const music = outro.music ? resolveTrack(outro.music) : undefined;
  await buildIntroFfmpeg({ ...outro, music, out: outroMp4, width: size.w, height: size.h });
  return outroMp4;
}

async function applyEncode(spec, video) {
  const e = spec.encode;
  if (!e) return;
  // Make sure every configured output's parent dir exists (e.g. out/work/ for intermediates).
  [e.srt, e.captionsMp4, e.narrateMp4, e.idleMp4, e.rampsMp4, e.mp4, e.gif, e.intro?.result, e.intro?.out,
    e.outro?.result, e.outro?.out, e.music?.out, e.sfx?.out]
    .forEach((p) => { if (p) ensureDir(dirname(resolve(p))); });
  if (e.srt) { await writeSrt(video, e.srt); console.log('SRT:', e.srt); }
  if (e.captionsMp4) {
    const co = e.captionsOpts || {};
    if (co.karaoke) {
      // Word-by-word karaoke needs the TTS word timings → pull narration (cached) and burn \kf.
      const narration = await getNarration(video, { ...(e.ttsOpts || {}), captionsFrom: video });
      await burnKaraoke(video, e.captionsMp4, { narration, style: co.style });
    } else {
      await burnSubs(video, e.captionsMp4, co);
    }
    console.log('CAPTIONS MP4:', e.captionsMp4);
  }
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
  if (e.rampsMp4) {
    // Deliberate speed ramps (slow-mo on key beats, brisk elsewhere) from the events sidecar.
    // Video-only, separate output (re-timing desyncs burned subs/voice — like idleMp4).
    let events = [];
    try { events = JSON.parse(readFileSync(`${video}.events.json`, 'utf8')).events; } catch { /* none */ }
    const dur = await probeDuration(video);
    await applySpeedSegments(video, e.rampsMp4, buildSpeedPlan(events, dur, e.ramps || {}), {});
    console.log('RAMPS MP4:', e.rampsMp4);
  }
  if (e.mp4) { await toMp4(video, e.mp4, e.mp4opts || {}); console.log('MP4:', e.mp4); }
  if (e.gif) { await toGif(video, e.gif, e.gifopts || {}); console.log('GIF:', e.gif); }

  // ---- Final composition: intro/outro bookends → ONE continuous music bed → step-synced SFX.
  let introDur = 0; // hoisted: the lower-thirds/SFX stages shift chapter/event times by the intro length
  const bookend = e.intro || e.outro;
  if (bookend || music || e.sfx) {
    // The finished demo to build on: explicit prependTo/appendTo, else the last meaningful output.
    let target = resolve(e.intro?.prependTo || e.outro?.appendTo
      || e.narrateMp4 || e.captionsMp4 || e.idleMp4 || e.mp4 || video);

    const work = () => ensureDir(workDir(spec.out));
    const tmpIn = (p, tag) => join(work(), basename(p).replace(/\.(\w+)$/, `.${tag}.$1`));
    // The single published filename for the composed video (back-compat: intro.result still wins).
    const result = resolve(e.intro?.result || e.outro?.result || (music && music.out) || (e.sfx && e.sfx.out)
      || (bookend ? target.replace(/\.(\w+)$/, '-final.$1') : target));
    const left = { music: !!music, sfx: !!e.sfx };

    // Bookends: build the intro/outro clips (sized to the demo) and concat into ONE timeline.
    if (bookend) {
      const parts = [];
      let introMp4, outroMp4;
      if (e.intro) { introMp4 = await buildIntroClip(spec, e.intro, target); introDur = await probeDuration(introMp4); parts.push(introMp4); }
      parts.push(target);
      if (e.outro) { outroMp4 = await buildOutroClip(spec, e.outro, target); parts.push(outroMp4); }
      const more = left.music || left.sfx;
      const out = more ? tmpIn(result, 'novol') : result;
      // Match-cut: dissolve/zoom the boundaries (intro→demo→outro) instead of a hard cut, when asked.
      const xf = e.transition || (e.intro && e.intro.matchCut ? {} : null);
      if (xf && parts.length >= 2) await xfadeJoin(parts, out, { duration: xf.duration, transition: xf.transition });
      else await concatVideos(parts, out);
      if (e.intro && !e.intro.out) { try { unlinkSync(introMp4); } catch { /* drop intro clip */ } }
      if (e.outro && !e.outro.out) { try { unlinkSync(outroMp4); } catch { /* drop outro clip */ } }
      target = out;
      if (!more) console.log('COMPOSED:', result);
    }

    // One continuous, ducked music bed over the WHOLE timeline (intro+demo+outro).
    if (music) {
      left.music = false;
      const track = resolveTrack(music.track || music.path); // path, bundled name/alias, or default
      const dur = await probeDuration(target);
      // Voice timings come from the demo's captions; shift them by the intro length.
      const narration = e.narrateMp4 ? await getNarration(video, { ...(e.ttsOpts || {}), captionsFrom: video }) : [];
      const keyframes = musicEnvelope(narration, dur, music, introDur);
      // ffmpeg can't read+write the same file → always bounce through a work/ temp, then rename.
      const tmp = tmpIn(result, 'mwork');
      const dest = left.sfx ? tmpIn(result, 'mtmp') : result;
      await addMusicBed(target, tmp, { path: track, keyframes, duration: dur, fadeIn: music.fadeIn, fadeOut: music.fadeOut });
      if (bookend) { try { unlinkSync(target); } catch { /* drop the .novol concat temp */ } }
      renameSync(tmp, dest);
      target = dest;
      if (!left.sfx) console.log(bookend ? 'COMPOSED+MUSIC:' : 'MUSIC:', result);
    }

    // Step-synced SFX (+ optional intro sting), mixed on top of the (ducked) audio. Offset by intro.
    if (e.sfx || (e.intro && e.intro.sting)) {
      const so = (typeof e.sfx === 'object') ? e.sfx : {};
      let events = [];
      try { events = JSON.parse(readFileSync(`${video}.events.json`, 'utf8')).events; } catch { /* no events sidecar */ }
      const cues = (e.sfx ? mapSfx(events, { ...so, offset: introDur + (so.offset || 0) }) : [])
        .map((c) => ({ ...c, path: resolveSfx(so.dir ? join(resolve(so.dir), c.name) : c.name) }))
        .filter((c) => c.path);
      // Intro sting: a one-shot at t=0 of the composed timeline.
      if (e.intro && e.intro.sting) {
        const p = resolveSfx(e.intro.sting);
        if (p) cues.unshift({ name: e.intro.sting, delay: 0, gain: e.intro.stingGain ?? 1, kind: 'sting', path: p });
      }
      if (cues.length) {
        const tmp = tmpIn(result, 'sfx');
        await muxSfx(target, tmp, cues);
        if (resolve(target) !== result) { try { unlinkSync(target); } catch { /* drop the temp */ } }
        renameSync(tmp, result);
        console.log('SFX:', result, `(${cues.length} efectos)`);
      } else {
        if (resolve(target) !== result) renameSync(target, result);
        if (e.sfx) console.log('SFX: sin efectos resueltos (añade audio/sfx/ o usa sfx.map). Salida:', result);
      }
    }

    e._composed = result;
  }

  // ---- Whole-clip passes on the composed final (so they span intro+demo+outro and any reframe
  //      inherits them): section transitions, lower-thirds, watermark, progress bar, colour grade. ----
  let finalVideo = e._composed || e.narrateMp4 || e.captionsMp4 || e.idleMp4 || e.mp4;
  finalVideo = finalVideo ? resolve(finalVideo) : null;
  if ((e.transitions || e.lowerThirds || e.watermark || e.progressBar || e.grade) && finalVideo) {
    const tmpIn = (p, tag) => join(ensureDir(workDir(spec.out)), basename(p).replace(/\.(\w+)$/, `.${tag}.$1`));
    // Stylized transitions at section beats (nav/chapter). Re-times slightly; do it before overlays.
    if (e.transitions) {
      const tr = (typeof e.transitions === 'object') ? e.transitions : {};
      const atKinds = tr.at || ['nav', 'chapter'];
      let evs = [];
      try { evs = JSON.parse(readFileSync(`${video}.events.json`, 'utf8')).events; } catch { /* none */ }
      const cuts = (evs || []).filter((x) => atKinds.includes(x.kind)).map((x) => x.t + introDur);
      if (cuts.length) {
        const tmp = tmpIn(finalVideo, 'tr');
        await transitionAtCuts(finalVideo, tmp, cuts, { transition: tr.transition || 'fade', duration: tr.duration || 0.4 });
        renameSync(tmp, finalVideo);
        console.log('TRANSITIONS:', finalVideo, `(${cuts.length})`);
      }
    }
    if (e.lowerThirds) {
      const lt = (typeof e.lowerThirds === 'object') ? e.lowerThirds : {};
      let evs = [];
      try { evs = JSON.parse(readFileSync(`${video}.events.json`, 'utf8')).events; } catch { /* no events sidecar */ }
      const chapters = (evs || []).filter((x) => x.kind === 'chapter').map((c) => ({ t: c.t + introDur, text: c.text }));
      if (chapters.length) {
        const tmp = tmpIn(finalVideo, 'lt');
        await burnLowerThirds(finalVideo, tmp, { events: chapters, style: lt.style || lt });
        renameSync(tmp, finalVideo);
        console.log('LOWER-THIRDS:', finalVideo, `(${chapters.length})`);
      }
    }
    if (e.watermark) {
      const wm = (typeof e.watermark === 'object') ? e.watermark : { text: String(e.watermark) };
      const tmp = tmpIn(finalVideo, 'wm');
      await burnWatermark(finalVideo, tmp, wm);
      renameSync(tmp, finalVideo);
      console.log('WATERMARK:', finalVideo);
    }
    if (e.grade) {
      const tmp = tmpIn(finalVideo, 'grade');
      await colorGrade(finalVideo, tmp, (typeof e.grade === 'object') ? e.grade : {});
      renameSync(tmp, finalVideo);
      console.log('GRADE:', finalVideo);
    }
    // Progress bar last: a UI overlay that should sit on top of the grade/vignette.
    if (e.progressBar) {
      const tmp = tmpIn(finalVideo, 'pb');
      await addProgressBar(finalVideo, tmp, (typeof e.progressBar === 'object') ? e.progressBar : {});
      renameSync(tmp, finalVideo);
      console.log('PROGRESS BAR:', finalVideo);
    }
    e._composed = finalVideo;
  }

  // ---- Extra aspect-ratio reframes (1:1, 9:16, …) from the finished video, for social. ----
  if (e.reframe) {
    const cfg = (e.reframe && typeof e.reframe === 'object' && !Array.isArray(e.reframe)) ? e.reframe : {};
    const ratios = Array.isArray(e.reframe) ? e.reframe
      : (typeof e.reframe === 'string' ? [e.reframe] : (cfg.ratios || []));
    const srcRef = resolve(e._composed || e.narrateMp4 || e.captionsMp4 || e.idleMp4 || e.mp4 || video);
    // Smart-crop (follow the action): build a focus timeline from rect-tagged events, shifted by the
    // intro length to match the composed timeline.
    let focus = [];
    if (cfg.follow) {
      let evs = [];
      try { evs = JSON.parse(readFileSync(`${video}.events.json`, 'utf8')).events; } catch { /* none */ }
      focus = (evs || []).filter((x) => x.rect && ['zoom', 'click', 'spotlight'].includes(x.kind))
        .map((x) => ({ t: x.t + introDur, cx: x.rect.cx }));
    }
    for (const ratio of ratios) {
      const tag = String(ratio).replace(/[:/x]/g, 'x');
      const out = resolve((cfg.out && cfg.out[ratio]) || srcRef.replace(/\.(\w+)$/, `-${tag}.$1`));
      ensureDir(dirname(out));
      if (cfg.follow) await smartReframe(srcRef, out, ratio, { focus, ...(cfg.opts || {}) });
      else await reframe(srcRef, out, ratio, cfg.opts || {});
      console.log('REFRAME', ratio + ':', out);
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

  let video = await record(async (d) => {
    for (const step of steps) await runStep(d, step);
  }, { ...sessionOpts(spec), url: spec.url, onGoto: (page) => postNav(page, spec) });
  console.log('VIDEO:', video);

  // Capture window (part of recording, so it runs even with --no-encode): trim the raw to the app's
  // declared content span and rebase the sidecars. Without a `capture` block this is a no-op.
  if (spec.capture) video = await applyCapture(spec, video);

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
  if (sel && ['type', 'click', 'move', 'zoomTo', 'zoomFit', 'spotlight', 'scroll', 'annotate', 'highlight'].includes(action)) {
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
export const __test = { subEnv, sliceSteps, norm, sessionOpts, preflight, runStep };

// CLI guard: `node src/run.js <guion.yml>` still works standalone. Canonicalize both paths with
// realpathSync so a symlinked invocation (e.g. via `npm link`) still resolves to this real file.
const canon = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
if (process.argv[1] && canon(process.argv[1]) === canon(fileURLToPath(import.meta.url))) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node src/run.js <guion.yml|guion.json>'); process.exit(1); }
  runScript(file).catch((err) => { console.error(err.message); process.exit(1); });
}
