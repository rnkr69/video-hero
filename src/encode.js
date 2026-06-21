import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { regularFont, boldFont, defaultFontName, resolveFont } from './fonts.js';

const run = (args, opts = {}) => new Promise((res, rej) => {
  // -loglevel error keeps output clean (suppresses banners/progress/benign warnings)
  // while still surfacing real errors. probeDuration uses its own spawn, so its stats
  // parsing is unaffected.
  const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit', ...opts });
  p.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg exit ' + c))));
});

// Real duration in seconds by decoding to the null muxer. The webm `Duration` header
// written by Playwright is unreliable, so we read the last decoded `time=` instead.
export function probeDuration(input) {
  return new Promise((resolve, reject) => {
    let err = '';
    const p = spawn(ffmpegPath, ['-i', input, '-f', 'null', '-']);
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => {
      const m = [...err.matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)];
      if (!m.length) return reject(new Error('could not probe duration of ' + input));
      const t = m[m.length - 1];
      resolve(+t[1] * 3600 + +t[2] * 60 + +t[3]);
    });
  });
}

// Pixel dimensions of the first video stream (for ASS PlayRes / intro sizing). Falls back
// to 1280x800 if ffmpeg's probe line can't be parsed.
export function probeSize(input) {
  return new Promise((res) => {
    let err = '';
    const p = spawn(ffmpegPath, ['-i', input, '-f', 'null', '-']);
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => {
      const m = err.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
      res(m ? { w: +m[1], h: +m[2] } : { w: 1280, h: 800 });
    });
  });
}

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

// Idle-speedup: compress the "dead time" (the scripted holds) while keeping action at
// 1x. The recorder writes the idle segments to `<video>.idle.json`; we read them (or
// take `opts.idle`), build a piecewise setpts (split → trim → setpts → concat) and
// re-encode. Each idle span is sped by `speed` but never shrunk below `floor` seconds
// (so a held zoom stays readable), and spans shorter than `minIdle` are left untouched.
// Pure: idle ranges → speed segments [{a,b,speed}] (active 1x interleaved with sped idle spans).
// Each idle span is sped by `speed` but never shorter than `floor` seconds; spans < `minIdle` are
// left at 1x. Tiny fragments (<0.02s) are dropped.
export function idleSegments(ranges, dur, { speed = 4, minIdle = 0.7, floor = 0.5 } = {}) {
  const idleSpans = (ranges || [])
    .map(([a, b]) => [Math.max(0, a), Math.min(dur, b)])
    .filter(([a, b]) => b - a >= minIdle)
    .sort((p, q) => p[0] - q[0]);
  const segs = [];
  let cur = 0;
  for (const [a, b] of idleSpans) {
    if (a <= cur) continue; // overlap / out of order — skip
    segs.push({ a: cur, b: a, speed: 1 });
    const newDur = Math.max(floor, (b - a) / speed);
    segs.push({ a, b, speed: (b - a) / newDur });
    cur = b;
  }
  if (cur < dur) segs.push({ a: cur, b: dur, speed: 1 });
  return segs.filter((g) => g.b - g.a > 0.02);
}

// Re-time a video from piecewise speed segments [{a,b,speed}] (split → trim → setpts → concat).
// Video-only (changing PTS desyncs burned subs/voice — produce these as a separate output).
export async function applySpeedSegments(input, output, parts, { fps = 30 } = {}) {
  const clean = (parts || []).filter((g) => g.b - g.a > 0.02);
  // Nothing to re-time → straight transcode.
  if (clean.length <= 1) {
    return run(['-y', '-i', input, '-r', String(fps),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', output]);
  }
  const n = clean.length;
  const splitOuts = clean.map((_, i) => `[s${i}]`).join('');
  const chains = clean.map((g, i) =>
    `[s${i}]trim=start=${g.a.toFixed(3)}:end=${g.b.toFixed(3)},setpts=(PTS-STARTPTS)/${g.speed.toFixed(4)}[v${i}]`);
  const concat = clean.map((_, i) => `[v${i}]`).join('') + `concat=n=${n}:v=1:a=0[out]`;
  const filter = `[0:v]split=${n}${splitOuts};${chains.join(';')};${concat}`;
  return run(['-y', '-i', input, '-filter_complex', filter, '-map', '[out]', '-r', String(fps),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', output]);
}

// Idle-speedup: compress the scripted holds. Reads idle spans from `<video>.idle.json` (or
// `opts.idle`) and re-times via applySpeedSegments.
export async function speedupIdle(input, output, {
  idle, speed = 4, minIdle = 0.7, floor = 0.5, fps = 30,
} = {}) {
  let ranges = idle;
  if (!ranges) {
    try { ranges = JSON.parse(readFileSync(`${input}.idle.json`, 'utf8')).idle; }
    catch { ranges = []; }
  }
  const dur = await probeDuration(input);
  return applySpeedSegments(input, output, idleSegments(ranges, dur, { speed, minIdle, floor }), { fps });
}

// Pure: deliberate speed ramps from recorder events. A `base` speed everywhere (e.g. 1.4 = brisk),
// with slow-mo windows of `slowmo` speed centered on chosen beats (`at` kinds, ± `window` seconds).
// Returns merged speed segments [{a,b,speed}] covering [0,dur].
export function buildSpeedPlan(events, dur, { base = 1.4, slowmo = 0.5, at = ['click'], window = 0.6 } = {}) {
  const kinds = new Set(at);
  // Slow windows around matching beats, clipped and merged.
  const wins = (events || []).filter((e) => kinds.has(e.kind))
    .map((e) => [Math.max(0, e.t - window), Math.min(dur, e.t + window)])
    .sort((p, q) => p[0] - q[0]);
  const merged = [];
  for (const w of wins) {
    const last = merged[merged.length - 1];
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
    else merged.push([...w]);
  }
  // Walk the timeline: base speed outside windows, slowmo inside.
  const segs = [];
  let cur = 0;
  for (const [a, b] of merged) {
    if (a > cur) segs.push({ a: cur, b: a, speed: base });
    segs.push({ a: Math.max(cur, a), b, speed: slowmo });
    cur = b;
  }
  if (cur < dur) segs.push({ a: cur, b: dur, speed: base });
  return segs.filter((g) => g.b - g.a > 0.02);
}

// Best-effort font FAMILY name from a font file path (libass matches Styles by family, not file):
// strip the extension and any trailing weight/style word, so `Inter-Regular.ttf` and
// `Inter-Bold.ttf` both resolve to `Inter`. Falls back to the bundled default.
const familyOf = (file) => basename(String(file))
  .replace(/\.(ttf|otf|ttc)$/i, '')
  .replace(/[-_ ]?(thin|extralight|ultralight|light|regular|book|medium|semibold|demibold|bold|extrabold|ultrabold|black|heavy|italic|oblique)+$/i, '')
  .trim() || defaultFontName();

// Copy the fonts a libass overlay needs into `dir` so `fontsdir=.` finds them without relying on
// OS-installed fonts (same trick burnSubs uses). Returns the copied paths (to clean up afterwards).
function stageFonts(dir, extra = []) {
  const copied = [];
  for (const f of [regularFont(), boldFont(), ...extra.filter(Boolean)]) {
    if (!existsSync(f)) continue;
    const dest = join(dir, basename(f));
    try { copyFileSync(f, dest); copied.push(dest); } catch { /* font copy is best-effort */ }
  }
  return copied;
}

// Extract several frames and tile them into ONE image for fast visual review.
// This is the core of the Claude Code self-verification loop: one Read of the
// contact sheet shows cursor / typing / zoom / timing across the whole clip.
export async function contactSheet(input, times, output, {
  cols, scale = 640, label = true, font = regularFont(),
} = {}) {
  if (!Array.isArray(times) || times.length === 0) throw new Error('contactSheet: pass a non-empty times[] array');
  const n = times.length;
  const ncols = cols || Math.ceil(Math.sqrt(n));
  const nrows = Math.ceil(n / ncols);
  const dir = dirname(output);
  const stem = basename(output).replace(/\.(png|jpg|jpeg)$/i, '');
  const pad = (i) => String(i).padStart(2, '0');
  const tilePng = (i) => resolve(join(dir, `${stem}-tile-${pad(i)}.png`));
  const tileAss = (i) => resolve(join(dir, `${stem}-tile-${pad(i)}.ass`));
  const inAbs = resolve(input);
  // Stamp each frame with its timestamp. We render it with libass (the `ass` filter), NOT drawtext:
  // the bundled Linux ffmpeg-static omits drawtext (see buildPosAss), while libass is present on
  // every platform. Disabled automatically if the font isn't found (keeps the sheet working).
  const doLabel = label && existsSync(font);
  // Tiles are scaled to width=`scale`, height auto; derive the tile height from the source aspect so
  // the label .ass PlayRes matches the tile pixels 1:1 (libass positions are in PlayRes units).
  const size = doLabel ? await probeSize(inAbs).catch(() => ({ w: 1280, h: 800 })) : null;
  const tileH = size ? Math.max(2, Math.round((scale * size.h) / size.w)) : 0;
  const fam = doLabel ? familyOf(font) : null;
  const stagedFonts = doLabel ? stageFonts(dir, [font]) : [];
  // The numbered tiles (and the per-tile .ass + staged font copies) are throwaway intermediates —
  // clear them once the grid is built so they don't pile up in out/ (the main source of clutter).
  const rmTiles = () => {
    for (let i = 0; i < n; i++) {
      try { rmSync(tilePng(i), { force: true }); } catch { /* ignore */ }
      try { rmSync(tileAss(i), { force: true }); } catch { /* ignore */ }
    }
    for (const f of stagedFonts) { try { rmSync(f, { force: true }); } catch { /* ignore */ } }
  };
  // 1) extract each requested timestamp to a numbered, downscaled (labelled) tile.
  for (let i = 0; i < n; i++) {
    let vf = `scale=${scale}:-1`;
    let opts = {};
    if (doLabel) {
      writeFileSync(tileAss(i), buildPosAss(
        [{ text: `${times[i].toFixed(2)}s`, x: 12, y: 12, an: 7, font: fam, fontSize: 22,
          color: '#FFFFFF', box: true, boxColor: '#000000', boxAlpha: 0x73, boxPad: 8 }],
        { width: scale, height: tileH, duration: 3600 }), 'utf8');
      // cwd=dir so the filter references the .ass + fonts by basename (sidesteps drive-colon escaping).
      vf += `,ass=${basename(tileAss(i))}:fontsdir=.`;
      opts = { cwd: dir };
    }
    await run(['-y', '-ss', String(times[i]), '-i', inAbs, '-frames:v', '1', '-vf', vf, tilePng(i)], opts);
  }
  // A single frame needs no grid — just emit it.
  if (n === 1) {
    copyFileSync(tilePng(0), resolve(output));
    rmTiles();
    return output;
  }
  // 2) read the numbered tiles as an image sequence and lay them out in a grid. Use an
  // absolute, forward-slashed pattern (ffmpeg's image2 demuxer dislikes Windows '\').
  const pattern = resolve(join(dir, `${stem}-tile-%02d.png`)).replace(/\\/g, '/');
  await run(['-y', '-start_number', '0', '-i', pattern,
    '-frames:v', '1', '-vf', `tile=${ncols}x${nrows}:margin=8:padding=6:color=white`, resolve(output)]);
  rmTiles();
  return output;
}

// Mux delayed audio tracks onto a (silent) video. tracks: [{path, delay}] where delay
// is the start offset in seconds. Tracks are delayed with adelay and mixed with amix.
// Output duration follows the longest stream, so the video is never truncated.
export function muxAudio(input, output, tracks, { fps = 30 } = {}) {
  if (!tracks || !tracks.length) throw new Error('muxAudio: no audio tracks');
  const inputs = [];
  tracks.forEach((t) => inputs.push('-i', t.path));
  const delays = tracks.map((t, i) =>
    `[${i + 1}:a]adelay=${Math.round(t.delay * 1000)}:all=1[a${i}]`);
  const mixIn = tracks.map((_, i) => `[a${i}]`).join('');
  const filter = `${delays.join(';')};${mixIn}amix=inputs=${tracks.length}:normalize=0[aout]`;
  return run(['-y', '-i', input, ...inputs, '-filter_complex', filter,
    '-map', '0:v', '-map', '[aout]', '-r', String(fps),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '160k', output]);
}

// Piecewise-linear ffmpeg `volume` expression from keyframes [{t,vol}] (sorted, covering the
// whole clip). Used as `volume=eval=frame:volume='<expr>'` to automate a music bed's level.
function buildVolumeExpr(kf) {
  if (!kf || !kf.length) return '1';
  if (kf.length === 1) return kf[0].vol.toFixed(4);
  let expr = kf[kf.length - 1].vol.toFixed(4);
  for (let i = kf.length - 2; i >= 0; i--) {
    const a = kf[i], b = kf[i + 1];
    const dt = Math.max(1e-6, b.t - a.t);
    const seg = `(${a.vol.toFixed(4)}+(${(b.vol - a.vol).toFixed(4)})*(t-${a.t.toFixed(3)})/${dt.toFixed(3)})`;
    expr = `if(lt(t,${b.t.toFixed(3)}),${seg},${expr})`;
  }
  return expr;
}

// Mux TTS voice clips AND a ducked background-music bed onto a (silent) video.
//   voiceTracks: [{path, delay}]  — same shape as muxAudio (delay = start in seconds).
//   music: {path, keyframes, duration, fadeIn, fadeOut} — keyframes drive the duck envelope.
// The music is looped to cover the whole clip, leveled by the keyframe envelope, faded in/out,
// then mixed under the (delayed, amixed) voice. Output duration follows the video.
export function mixVoiceAndMusic(input, output, voiceTracks, music, { fps = 30 } = {}) {
  const voices = voiceTracks || [];
  const dur = music.duration;
  const fadeIn = music.fadeIn ?? 1.0;
  const fadeOut = music.fadeOut ?? 1.5;
  const fOutSt = Math.max(0, dur - fadeOut).toFixed(3);
  const expr = buildVolumeExpr(music.keyframes);

  const parts = [];
  let voiceLabel = null;
  if (voices.length) {
    voices.forEach((t, i) => parts.push(`[${i + 1}:a]adelay=${Math.round(t.delay * 1000)}:all=1[v${i}]`));
    if (voices.length === 1) voiceLabel = '[v0]';
    else {
      parts.push(`${voices.map((_, i) => `[v${i}]`).join('')}amix=inputs=${voices.length}:normalize=0[voice]`);
      voiceLabel = '[voice]';
    }
  }
  const musicIdx = voices.length + 1;
  parts.push(`[${musicIdx}:a]atrim=0:${dur.toFixed(3)},asetpts=PTS-STARTPTS,` +
    `volume=eval=frame:volume='${expr}',` +
    `afade=t=in:st=0:d=${fadeIn},afade=t=out:st=${fOutSt}:d=${fadeOut}[music]`);

  let outLabel = '[music]';
  if (voiceLabel) { parts.push(`${voiceLabel}[music]amix=inputs=2:normalize=0[aout]`); outLabel = '[aout]'; }

  const inputs = ['-i', input];
  voices.forEach((t) => inputs.push('-i', t.path));
  inputs.push('-stream_loop', '-1', '-i', music.path); // loop music to cover the whole clip
  return run(['-y', ...inputs, '-filter_complex', parts.join(';'),
    '-map', '0:v', '-map', outLabel, '-r', String(fps),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '160k', '-t', dur.toFixed(3), output]);
}

// ---- Intro card + concat ---------------------------------------------------

// True if the file has at least one audio stream (used to decide concat audio handling).
export function probeHasAudio(input) {
  return new Promise((res) => {
    let err = '';
    const p = spawn(ffmpegPath, ['-i', input, '-f', 'null', '-']);
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => res(/Audio:/.test(err)));
  });
}

// Compose an intro card 100% with ffmpeg: solid background, optional centered logo, title and
// subtitle (rendered with libass — see buildPosAss), fade-in/out and an optional subtle zoom
// push-in. Carries an audio track (silent, or `music` faded out) so it concatenates cleanly with
// the demo. Built at WxH so it matches the target video exactly.
export async function buildIntroFfmpeg(opts = {}) {
  const { out, logo, title = '', subtitle = '', bg = '#0B0F1A',
    animation = 'fade-zoom', music, width = 1280, height = 800, fps = 30,
    font, fontBold } = opts;
  const dur = opts.duration ?? 2.8;
  const W = width, H = height;
  const color = `color=c=${String(bg).replace('#', '0x')}:s=${W}x${H}:d=${dur.toFixed(3)}:r=${fps}`;

  const inputs = ['-f', 'lavfi', '-i', color];
  let logoIdx = -1;
  if (logo) { inputs.push('-i', resolve(logo)); logoIdx = 1; }
  const audioIdx = logoIdx > 0 ? 2 : 1;
  if (music) inputs.push('-stream_loop', '-1', '-i', resolve(music));
  else inputs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');

  const parts = [];
  let cur = '[0:v]';
  if (logoIdx > 0) {
    parts.push(`[${logoIdx}:v]scale=-1:${Math.round(H * 0.22)}[lg]`);
    parts.push(`${cur}[lg]overlay=(W-w)/2:${Math.round(H * 0.26)}[v1]`);
    cur = '[v1]';
  }
  // Title + subtitle via libass. Defaults to the bundled Inter (cross-platform, no OS fonts needed);
  // `font`/`fontBold` override (a path, bundled name, or alias) — the family name is derived from the
  // file so the .ass Style resolves through `fontsdir`. The .ass + font copies live next to the
  // output and ffmpeg runs with cwd there, so the filter only needs basenames (no drive-colon issue).
  const fontFileR = resolveFont(font);
  const fontFileB = resolveFont(fontBold || font, boldFont());
  const outAbs = resolve(out);
  const workDir = dirname(outAbs);
  let assFile = null;
  let stagedFonts = [];
  const chain = [];
  if (title || subtitle) {
    assFile = join(workDir, `_intro-${basename(outAbs).replace(/\.\w+$/, '')}.ass`);
    const lines = [];
    if (title) {
      lines.push({ text: title, x: W / 2, y: Math.round(H * 0.54), an: 8,
        font: familyOf(fontFileB), fontSize: Math.round(H * 0.075), color: '#FFFFFF', bold: true });
    }
    if (subtitle) {
      lines.push({ text: subtitle, x: W / 2, y: Math.round(H * 0.66), an: 8,
        font: familyOf(fontFileR), fontSize: Math.round(H * 0.036),
        color: '#FFFFFF', alpha: Math.round((1 - 0.82) * 255) });
    }
    writeFileSync(assFile, buildPosAss(lines, { width: W, height: H, duration: dur }), 'utf8');
    stagedFonts = stageFonts(workDir, [fontFileR, fontFileB]);
    chain.push(`ass=${basename(assFile)}:fontsdir=.`);
  }
  if (String(animation).includes('zoom')) {
    chain.push(`zoompan=z='min(pzoom+0.0006,1.06)':d=1:s=${W}x${H}:fps=${fps}`);
  }
  const fd = Math.min(0.5, dur / 3);
  chain.push(`fade=t=in:st=0:d=${fd.toFixed(3)}`, `fade=t=out:st=${(dur - fd).toFixed(3)}:d=${fd.toFixed(3)}`);
  parts.push(`${cur}${chain.join(',')}[vout]`);

  let aLabel = `${audioIdx}:a`; // plain input stream (anullsrc) → no filtergraph brackets
  if (music) {
    const fo = Math.min(1.0, dur / 2);
    parts.push(`[${audioIdx}:a]atrim=0:${dur.toFixed(3)},asetpts=PTS-STARTPTS,` +
      `afade=t=out:st=${(dur - fo).toFixed(3)}:d=${fo.toFixed(3)}[aout]`);
    aLabel = '[aout]';
  }
  try {
    await run(['-y', ...inputs, '-filter_complex', parts.join(';'),
      '-map', '[vout]', '-map', aLabel, '-t', dur.toFixed(3),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart',
      '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', outAbs], { cwd: workDir });
  } finally {
    // The .ass and staged font copies are build artifacts — only needed during the burn.
    if (assFile) { try { rmSync(assFile, { force: true }); } catch { /* artifact */ } }
    for (const f of stagedFonts) { try { rmSync(f, { force: true }); } catch { /* font copy */ } }
  }
}

// Concatenate clips (intro + demo) by re-encoding through the concat filter — robust to the
// different encoders the parts came from. Normalizes SAR/fps; keeps audio only if EVERY part
// has it (subs-only / video-only outputs have no audio, so the result is then silent too).
// Assumes all parts share the same WxH (the intro is built at the target's size).
export async function concatVideos(parts, output, { fps = 30 } = {}) {
  const has = await Promise.all(parts.map(probeHasAudio));
  const withAudio = has.every(Boolean);
  const inputs = parts.flatMap((p) => ['-i', p]);
  const v = parts.map((_, i) => `[${i}:v]setsar=1,fps=${fps},format=yuv420p[v${i}]`);
  if (withAudio) {
    const a = parts.map((_, i) => `[${i}:a]aresample=async=1:first_pts=0[a${i}]`);
    const cin = parts.map((_, i) => `[v${i}][a${i}]`).join('');
    const filter = `${v.join(';')};${a.join(';')};${cin}concat=n=${parts.length}:v=1:a=1[v][a]`;
    return run(['-y', ...inputs, '-filter_complex', filter, '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart',
      '-c:a', 'aac', '-b:a', '160k', output]);
  }
  const cin = parts.map((_, i) => `[v${i}]`).join('');
  const filter = `${v.join(';')};${cin}concat=n=${parts.length}:v=1:a=0[v]`;
  return run(['-y', ...inputs, '-filter_complex', filter, '-map', '[v]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', output]);
}

// Lay a ducked, looped music bed UNDER a finished video's existing audio (or over silence if
// it has none). The keyframe envelope is authored on the FINAL timeline, so the same call
// covers an intro + demo continuously. music: {path, keyframes, duration, fadeIn, fadeOut}.
export async function addMusicBed(input, output, music, { fps = 30 } = {}) {
  const dur = music.duration;
  const fadeIn = music.fadeIn ?? 1.0, fadeOut = music.fadeOut ?? 1.5;
  const fOutSt = Math.max(0, dur - fadeOut).toFixed(3);
  const expr = buildVolumeExpr(music.keyframes);
  const hasA = await probeHasAudio(input);
  const parts = [`[1:a]atrim=0:${dur.toFixed(3)},asetpts=PTS-STARTPTS,` +
    `volume=eval=frame:volume='${expr}',` +
    `afade=t=in:st=0:d=${fadeIn},afade=t=out:st=${fOutSt}:d=${fadeOut}[m]`];
  let outLabel = '[m]';
  if (hasA) { parts.push('[0:a][m]amix=inputs=2:normalize=0[aout]'); outLabel = '[aout]'; }
  return run(['-y', '-i', input, '-stream_loop', '-1', '-i', music.path,
    '-filter_complex', parts.join(';'), '-map', '0:v', '-map', outLabel, '-r', String(fps),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '160k', '-t', dur.toFixed(3), output]);
}

// Transcode to mp4 ADDING a silent stereo audio track. Used for the HTML intro (Playwright
// records video-only) so the concat keeps the demo's audio (concatVideos needs every part to
// carry an audio stream).
export function toMp4Silent(input, output, { fps = 30 } = {}) {
  return run(['-y', '-i', input, '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-map', '0:v', '-map', '1:a', '-shortest', '-r', String(fps),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '160k', output]);
}

// ---- Reframe (extra aspect ratios) ----------------------------------------

// Pick a WxH canvas of the given aspect that FITS the source without cropping its content: keep the
// limiting source dimension and derive the other. The source is later centered over a blurred,
// scaled-up copy of itself (intentional-looking padding). `aspect` like '9:16','1:1','4:5'.
export function aspectToCanvas(srcW, srcH, aspect) {
  const [aw, ah] = String(aspect).split(/[:x/]/).map(Number);
  if (!aw || !ah) throw new Error('reframe: bad aspect ' + aspect);
  const ar = aw / ah;
  let W, H;
  if (ar < srcW / srcH) { W = srcW; H = Math.round(W / ar); }   // taller target → pad top/bottom
  else { H = srcH; W = Math.round(H * ar); }                    // wider target → pad left/right
  const even = (n) => { n = Math.max(2, Math.round(n)); return n % 2 ? n + 1 : n; };
  return { w: even(W), h: even(H) };
}

// Produce an extra aspect-ratio cut from a finished video: the source is contained (no crop) and
// centered over a blurred, cover-scaled copy of itself, so 16:9 footage reads naturally as 9:16/1:1
// for social without losing any pixels. Carries through the source audio if present.
export async function reframe(input, output, aspect, { fps = 30, blur = 24, dim = 0.06 } = {}) {
  const src = await probeSize(input);
  const { w: W, h: H } = aspectToCanvas(src.w, src.h, aspect);
  const filter =
    '[0:v]split=2[bg][fg];' +
    `[bg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
    `gblur=sigma=${blur},eq=brightness=-${dim}[bgb];` +
    `[fg]scale=${W}:${H}:force_original_aspect_ratio=decrease[fgc];` +
    '[bgb][fgc]overlay=(W-w)/2:(H-h)/2[v]';
  const hasA = await probeHasAudio(input);
  const map = hasA ? ['-map', '[v]', '-map', '0:a?'] : ['-map', '[v]'];
  const acodec = hasA ? ['-c:a', 'aac', '-b:a', '160k'] : [];
  return run(['-y', '-i', input, '-filter_complex', filter, ...map, '-r', String(fps),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', ...acodec, output]);
}

// ---- Step-synced SFX ------------------------------------------------------

// Default mapping from a recorder event `kind` to a bundled SFX name. `null` mutes a kind.
// Resolution of the name → file (and dropping unresolved ones) happens in the caller via resolveSfx.
const DEFAULT_SFX_MAP = {
  click: 'click', nav: 'click', zoom: 'whoosh', keycap: 'key', keypress: 'key', success: 'chime',
  // Muted by default so one gesture = one sound: `zoomOut` (the zoom-IN already whooshed — a second
  // whoosh on reset doubles up, especially when a reset runs into the next zoom), `spotlight` (rides
  // along with a `zoomFit`), and the high-frequency `type`/`move`/`scroll`.
  zoomOut: null, spotlight: null, type: null, move: null, scroll: null,
};

// Pure: turn recorder events ([{t,kind,...}]) into SFX cues ([{name,delay,gain,kind}]). `offset`
// shifts every cue on the timeline (e.g. a prepended intro). `map` overrides per kind (a name, a
// {name,gain} object, or null to mute); `only` restricts to a kind whitelist. `gain` is the default
// level (the bundled SFX are loud, so it's conservative). `minGap` drops a cue when the SAME sound
// already fired within that many seconds (so one sound never double-hits). ffmpeg-free.
export function mapSfx(events, { map = {}, gain = 0.45, offset = 0, only, minGap = 0.3 } = {}) {
  const m = { ...DEFAULT_SFX_MAP, ...map };
  const cues = (events || [])
    .map((e) => {
      const entry = Object.prototype.hasOwnProperty.call(m, e.kind)
        ? m[e.kind] : (e.kind === 'sfx' ? e.name : undefined);
      if (!entry) return null;
      const name = typeof entry === 'object' ? entry.name : entry;
      const g = (typeof entry === 'object' && entry.gain != null) ? entry.gain : gain;
      if (!name) return null;
      return { name, delay: Math.max(0, e.t + offset), gain: g, kind: e.kind };
    })
    .filter(Boolean)
    .filter((c) => !only || only.includes(c.kind))
    .sort((a, b) => a.delay - b.delay);
  // Cooldown per sound: skip a cue if the same sound is still effectively playing/just played.
  const last = {};
  return cues.filter((c) => {
    if (last[c.name] != null && c.delay - last[c.name] < minGap) return false;
    last[c.name] = c.delay;
    return true;
  });
}

// Lay short one-shot SFX over a finished video's audio, synced to the cues ([{path,delay,gain}]).
// Mixed ON TOP of the existing (already music-ducked) track with normalize=0 so levels are kept;
// dropout_transition=0 avoids amix pumping the bed up as one-shots end. Assumes a non-empty list.
export async function muxSfx(input, output, cues, { fps = 30 } = {}) {
  const list = (cues || []).filter((c) => c.path);
  if (!list.length) throw new Error('muxSfx: no resolvable SFX cues');
  const dur = await probeDuration(input);
  const hasA = await probeHasAudio(input);
  const inputs = [];
  list.forEach((c) => inputs.push('-i', c.path));
  const chains = list.map((c, i) =>
    `[${i + 1}:a]adelay=${Math.round(c.delay * 1000)}:all=1,volume=${(c.gain ?? 1).toFixed(3)}[s${i}]`);
  const sfxIn = list.map((_, i) => `[s${i}]`).join('');
  const baseIn = hasA ? '[0:a]' : '';
  const n = list.length + (hasA ? 1 : 0);
  const parts = [...chains, `${baseIn}${sfxIn}amix=inputs=${n}:normalize=0:dropout_transition=0[aout]`];
  return run(['-y', '-i', input, ...inputs, '-filter_complex', parts.join(';'),
    '-map', '0:v', '-map', '[aout]', '-r', String(fps),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '160k', '-t', dur.toFixed(3), output]);
}

// ---- Watermark ------------------------------------------------------------

const WM_POS = { br: 3, bl: 1, tr: 9, tl: 7 };       // libass numpad alignment per corner
const WM_OVERLAY = (m) => ({ br: `W-w-${m}:H-h-${m}`, bl: `${m}:H-h-${m}`, tr: `W-w-${m}:${m}`, tl: `${m}:${m}` });

// Burn a corner watermark/bug onto a finished video: a logo PNG (overlay, alpha-scaled) OR text
// (libass via buildPosAss). Spans the whole clip. pos: br|bl|tr|tl. Keeps the source audio.
export async function burnWatermark(input, output, opts = {}) {
  const inAbs = resolve(input), outAbs = resolve(output);
  const { text = '', logo, pos = 'br', opacity = 0.5, margin = 28, color = '#FFFFFF' } = opts;
  const size = await probeSize(inAbs);
  const hasA = await probeHasAudio(inAbs);
  if (logo) {
    const at = (WM_OVERLAY(margin))[pos] || (WM_OVERLAY(margin)).br;
    const filter = `[1:v]format=rgba,colorchannelmixer=aa=${opacity}[wm];[0:v][wm]overlay=${at}[v]`;
    const map = hasA ? ['-map', '[v]', '-map', '0:a?'] : ['-map', '[v]'];
    const ac = hasA ? ['-c:a', 'aac', '-b:a', '160k'] : [];
    return run(['-y', '-i', inAbs, '-i', resolve(logo), '-filter_complex', filter, ...map, '-r', '30',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', ...ac, outAbs]);
  }
  const fs = opts.fontSize || Math.round(size.h * 0.03);
  const an = WM_POS[pos] || 3;
  const x = (pos === 'br' || pos === 'tr') ? size.w - margin : margin;
  const y = (pos === 'br' || pos === 'bl') ? size.h - margin : margin;
  const dur = await probeDuration(inAbs);
  const assPath = resolve(outAbs.replace(/\.\w+$/, '') + '.wm.ass');
  writeFileSync(assPath, buildPosAss([{ text, x, y, an, fontSize: fs, color,
    alpha: Math.round((1 - opacity) * 255), bold: true, outline: 1, outlineColor: '#000000' }],
  { width: size.w, height: size.h, duration: dur }), 'utf8');
  const copied = [];
  for (const f of [regularFont(), boldFont()]) {
    const d = join(dirname(assPath), basename(f));
    try { copyFileSync(f, d); copied.push(d); } catch { /* ignore */ }
  }
  const aargs = hasA ? ['-c:a', 'copy'] : [];
  await run(['-y', '-i', inAbs, '-vf', `ass=${basename(assPath)}:fontsdir=.`, '-r', '30',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', ...aargs, outAbs],
  { cwd: dirname(assPath) });
  try { rmSync(assPath, { force: true }); } catch { /* artifact */ }
  for (const c of copied) { try { rmSync(c, { force: true }); } catch { /* font copy */ } }
  return outAbs;
}

// ---- Lower-thirds / chapter titles ----------------------------------------

// Build an .ass with an animated lower-third strip per chapter: a libass box (bottom-left) that
// slides in from the left and fades. Chapter events ([{t,text}]) span until the next chapter (or
// +`hold` seconds, default 3) — reuses toCues for the spans. Times are on the FINAL timeline.
export function buildLowerThirds(events, duration, size = {}, style = {}) {
  const s = {
    font: defaultFontName(), fontSize: 30, color: '#FFFFFF', boxColor: '#111418', boxAlpha: 0x24,
    marginL: 56, marginV: 70, boxPad: 16, fadeIn: 220, fadeOut: 220, slide: 44, hold: 3.0, playResY: 800,
    ...style,
  };
  const refH = s.playResY;
  const refW = Math.round(((size.w || 1280) / (size.h || 800)) * refH);
  const primary = hexToAss(s.color, 0);
  const back = hexToAss(s.boxColor, s.boxAlpha);
  const cues = toCues((events || []).map((e) => ({ t: e.t, text: e.text })), duration)
    .map((c) => ({ ...c, end: s.hold ? Math.min(c.end, c.start + s.hold) : c.end }))
    .filter((c) => c.end > c.start);
  const x = s.marginL, y = refH - s.marginV;
  const head =
`[Script Info]
ScriptType: v4.00+
PlayResX: ${refW}
PlayResY: ${refH}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: LT,${s.font},${s.fontSize},${primary},&H000000FF,${back},${back},-1,0,0,0,100,100,0,0,3,${s.boxPad},0,1,${s.marginL},64,${s.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines = cues.map((c) => {
    const durMs = Math.max(0, (c.end - c.start) * 1000);
    const fin = Math.round(Math.min(s.fadeIn, durMs));
    const fout = Math.round(Math.min(s.fadeOut, Math.max(0, durMs - fin)));
    const tags = `{\\fad(${fin},${fout})\\move(${x - s.slide},${y},${x},${y},0,${fin})}`;
    const text = String(c.text).replace(/\r?\n/g, '\\N');
    return `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},LT,,0,0,0,,${tags}${text}`;
  });
  return head + lines.join('\n') + '\n';
}

// Burn animated lower-thirds onto a video from chapter events (already on the final timeline).
export async function burnLowerThirds(input, output, { events, style } = {}) {
  const inAbs = resolve(input), outAbs = resolve(output);
  const [dur, size] = await Promise.all([probeDuration(inAbs), probeSize(inAbs)]);
  const assPath = resolve(outAbs.replace(/\.\w+$/, '') + '.lt.ass');
  writeFileSync(assPath, buildLowerThirds(events || [], dur, size, style || {}), 'utf8');
  const copied = [];
  for (const f of [regularFont(), boldFont()]) {
    const d = join(dirname(assPath), basename(f));
    try { copyFileSync(f, d); copied.push(d); } catch { /* ignore */ }
  }
  const hasA = await probeHasAudio(inAbs);
  const aargs = hasA ? ['-c:a', 'copy'] : [];
  await run(['-y', '-i', inAbs, '-vf', `ass=${basename(assPath)}:fontsdir=.`, '-r', '30',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', ...aargs, outAbs],
  { cwd: dirname(assPath) });
  try { rmSync(assPath, { force: true }); } catch { /* artifact */ }
  for (const c of copied) { try { rmSync(c, { force: true }); } catch { /* font copy */ } }
  return outAbs;
}

// ---- Match-cut (xfade join) -----------------------------------------------

// Pure: xfade offsets for an N-clip chain crossfaded by `d` seconds at each boundary. offset_i is
// where clip i+1's transition begins on the running composed timeline (overlap accounted for).
export function xfadeOffsets(durs, d) {
  const offs = [];
  let acc = durs[0];
  for (let i = 1; i < durs.length; i++) { offs.push(+(acc - d).toFixed(3)); acc = acc + durs[i] - d; }
  return offs;
}

// Join clips with an xfade transition at each boundary (zoom-dissolve "match cut" instead of a hard
// cut). All parts must share WxH/fps. Crossfades audio with acrossfade when every part has it; else
// video-only (a later music bed re-adds audio).
export async function xfadeJoin(parts, output, { duration = 0.5, transition = 'fade', fps = 30 } = {}) {
  if (!parts || parts.length < 2) throw new Error('xfadeJoin needs ≥2 parts');
  const durs = await Promise.all(parts.map(probeDuration));
  const has = await Promise.all(parts.map(probeHasAudio));
  const withAudio = has.every(Boolean);
  const offs = xfadeOffsets(durs, duration);
  const inputs = parts.flatMap((p) => ['-i', p]);
  const norm = parts.map((_, i) => `[${i}:v]setsar=1,fps=${fps},format=yuv420p[n${i}]`);
  const vchain = [];
  let prev = '[n0]';
  for (let i = 1; i < parts.length; i++) {
    const out = i === parts.length - 1 ? '[v]' : `[x${i}]`;
    vchain.push(`${prev}[n${i}]xfade=transition=${transition}:duration=${duration}:offset=${offs[i - 1]}${out}`);
    prev = out;
  }
  if (withAudio) {
    const achain = [];
    let ap = '[0:a]';
    for (let i = 1; i < parts.length; i++) {
      const out = i === parts.length - 1 ? '[a]' : `[xa${i}]`;
      achain.push(`${ap}[${i}:a]acrossfade=d=${duration}:c1=tri:c2=tri${out}`);
      ap = out;
    }
    const filter = [...norm, ...vchain, ...achain].join(';');
    return run(['-y', ...inputs, '-filter_complex', filter, '-map', '[v]', '-map', '[a]', '-r', String(fps),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart',
      '-c:a', 'aac', '-b:a', '160k', output]);
  }
  const filter = [...norm, ...vchain].join(';');
  return run(['-y', ...inputs, '-filter_complex', filter, '-map', '[v]', '-r', String(fps),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', output]);
}

// ---- Transitions between beats (intra-clip xfade at cut points) -----------

// Apply a stylized transition (xfade) at each cut time WITHIN one clip — punctuates section changes
// (nav/chapter beats). Splits at `cuts`, crossfades video and (when present) audio. Slightly
// shortens the clip by (n-1)*duration. `transition` is any ffmpeg xfade name (zoomin/hblur/radial/
// wipeleft/fade…). Assumes a non-empty `cuts`.
export async function transitionAtCuts(input, output, cuts, { transition = 'fade', duration = 0.4, fps = 30 } = {}) {
  const dur = await probeDuration(input);
  const pts = [...new Set((cuts || []).map((t) => +(+t).toFixed(3)))]
    .filter((t) => t > duration && t < dur - duration).sort((a, b) => a - b);
  if (!pts.length) throw new Error('transitionAtCuts: no usable cut points');
  const bounds = [0, ...pts, dur];
  const segDurs = bounds.slice(1).map((b, i) => b - bounds[i]);
  const n = segDurs.length;
  const offs = xfadeOffsets(segDurs, duration);
  const hasA = await probeHasAudio(input);
  const parts = [`[0:v]split=${n}${segDurs.map((_, i) => `[s${i}]`).join('')}`];
  segDurs.forEach((_, i) => parts.push(
    `[s${i}]trim=start=${bounds[i].toFixed(3)}:end=${bounds[i + 1].toFixed(3)},setpts=PTS-STARTPTS,fps=${fps},format=yuv420p[v${i}]`));
  let vp = '[v0]';
  for (let i = 1; i < n; i++) {
    const out = i === n - 1 ? '[v]' : `[vx${i}]`;
    parts.push(`${vp}[v${i}]xfade=transition=${transition}:duration=${duration}:offset=${offs[i - 1]}${out}`);
    vp = out;
  }
  let map = ['-map', '[v]']; let aargs = [];
  if (hasA) {
    parts.push(`[0:a]asplit=${n}${segDurs.map((_, i) => `[as${i}]`).join('')}`);
    segDurs.forEach((_, i) => parts.push(
      `[as${i}]atrim=start=${bounds[i].toFixed(3)}:end=${bounds[i + 1].toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`));
    let ap = '[a0]';
    for (let i = 1; i < n; i++) {
      const out = i === n - 1 ? '[a]' : `[ax${i}]`;
      parts.push(`${ap}[a${i}]acrossfade=d=${duration}:c1=tri:c2=tri${out}`);
      ap = out;
    }
    map = ['-map', '[v]', '-map', '[a]']; aargs = ['-c:a', 'aac', '-b:a', '160k'];
  }
  return run(['-y', '-i', input, '-filter_complex', parts.join(';'), ...map, '-r', String(fps),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', ...aargs, output]);
}

// ---- Progress bar + colour grade (whole-clip overlays) --------------------

// Pure: an .ass that draws a progress bar growing left→right in `steps` discrete slices (smooth
// enough at ~0.4s/slice). Rendered with libass because the ffmpeg-static `drawbox` does NOT
// re-evaluate its width expression per frame (it bakes a single, full-width box). pos: bottom | top.
export function buildProgressBarAss(dur, size = {}, { color = '#6C5CE7', height = 6, pos = 'bottom', opacity = 0.9, steps } = {}) {
  const W = Math.round(size.w || 1280), H = Math.round(size.h || 800);
  const n = steps || Math.max(8, Math.min(240, Math.round(dur / 0.4)));
  const dt = dur / n;
  const y = pos === 'top' ? 0 : H - height;
  const hex = String(color).replace('#', '').padStart(6, '0');
  const bgr = (hex.slice(4, 6) + hex.slice(2, 4) + hex.slice(0, 2)).toUpperCase(); // ASS is BGR
  const a = Math.max(0, Math.min(255, Math.round((1 - opacity) * 255))).toString(16).padStart(2, '0').toUpperCase();
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: PB,Arial,10,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines = [];
  for (let i = 0; i < n; i++) {
    const start = i * dt, end = (i === n - 1) ? dur : (i + 1) * dt;
    const bw = Math.max(1, Math.round((W * (i + 1)) / n));
    lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},PB,,0,0,0,,` +
      `{\\an7\\pos(0,${y})\\1c&H${bgr}&\\1a&H${a}&\\bord0\\shad0\\p1}m 0 0 l ${bw} 0 ${bw} ${height} 0 ${height}{\\p0}`);
  }
  return head + lines.join('\n') + '\n';
}

// Burn a progress bar that grows over the clip (bottom by default). Keeps the source audio.
export async function addProgressBar(input, output, { color = '#6C5CE7', height = 6, pos = 'bottom', opacity = 0.9, fps = 30 } = {}) {
  const inAbs = resolve(input), outAbs = resolve(output);
  const [dur, size] = await Promise.all([probeDuration(inAbs), probeSize(inAbs)]);
  const assPath = resolve(outAbs.replace(/\.\w+$/, '') + '.pb.ass');
  writeFileSync(assPath, buildProgressBarAss(dur, size, { color, height, pos, opacity }), 'utf8');
  const hasA = await probeHasAudio(inAbs);
  const aargs = hasA ? ['-c:a', 'copy'] : [];
  await run(['-y', '-i', inAbs, '-vf', `ass=${basename(assPath)}`, '-r', String(fps),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', ...aargs, outAbs],
  { cwd: dirname(assPath) });
  try { rmSync(assPath, { force: true }); } catch { /* artifact */ }
  return outAbs;
}

// A subtle colour grade for consistency across demos: optional 3D LUT (.cube), eq tweaks and a
// vignette. All parts optional; keeps the source audio.
export async function colorGrade(input, output, { vignette = true, contrast = 1.0, saturation = 1.0, brightness = 0, lut, fps = 30 } = {}) {
  const inAbs = resolve(input), outAbs = resolve(output);
  const hasA = await probeHasAudio(inAbs);
  const chain = [];
  let cwd;
  if (lut) { const lAbs = resolve(lut); cwd = dirname(lAbs); chain.push(`lut3d=${basename(lAbs)}`); }
  if (contrast !== 1 || saturation !== 1 || brightness !== 0) {
    chain.push(`eq=contrast=${contrast}:saturation=${saturation}:brightness=${brightness}`);
  }
  if (vignette) chain.push('vignette=PI/5');
  if (!chain.length) chain.push('null');
  const aargs = hasA ? ['-c:a', 'copy'] : [];
  return run(['-y', '-i', inAbs, '-vf', chain.join(','), '-r', String(fps),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', ...aargs, outAbs],
  cwd ? { cwd } : {});
}

// ---- Karaoke captions (word-by-word) --------------------------------------

// Pure: build an .ass with per-word karaoke fill (\kf). narration: [{t,text,duration}] (the TTS
// timings from getNarration). Each caption is one Dialogue spanning [t, t+duration]; words get a
// \kf of their share of the duration (weighted by length). PrimaryColour = the "sung" fill,
// SecondaryColour = the upcoming word colour.
export function buildKaraokeAss(narration, size = {}, style = {}) {
  const s = {
    font: defaultFontName(), fontSize: 26, color: '#FFFFFF', fillColor: '#6C5CE7',
    outlineColor: '#101010', outline: 2, shadow: 0.5, bold: true,
    alignment: 2, marginV: 56, marginL: 64, marginR: 64, playResY: 800, ...style,
  };
  const refH = s.playResY;
  const refW = Math.round(((size.w || 1280) / (size.h || 800)) * refH);
  const primary = hexToAss(s.fillColor, 0);     // sung
  const secondary = hexToAss(s.color, 0);        // not yet sung
  const outlineCol = hexToAss(s.outlineColor, 0);
  const head =
`[Script Info]
ScriptType: v4.00+
PlayResX: ${refW}
PlayResY: ${refH}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: K,${s.font},${s.fontSize},${primary},${secondary},${outlineCol},&H80000000,${s.bold ? -1 : 0},0,0,0,100,100,0,0,1,${s.outline},${s.shadow},${s.alignment},${s.marginL},${s.marginR},${s.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines = (narration || []).filter((c) => c.text && c.duration > 0).map((c) => {
    const words = String(c.text).split(/\s+/).filter(Boolean);
    const totalCs = Math.max(1, Math.round(c.duration * 100));
    const sumLen = words.reduce((a, w) => a + w.length, 0) || 1;
    let used = 0;
    const body = words.map((w, i) => {
      let cs = (i === words.length - 1) ? totalCs - used : Math.max(1, Math.round(totalCs * w.length / sumLen));
      used += cs;
      return `{\\kf${cs}}${w} `;
    }).join('').trimEnd();
    return `Dialogue: 0,${assTime(c.t)},${assTime(c.t + c.duration)},K,,0,0,0,,${body}`;
  });
  return head + lines.join('\n') + '\n';
}

// Burn word-by-word karaoke captions from TTS narration ([{t,text,duration}]).
export async function burnKaraoke(input, output, { narration, style } = {}) {
  const inAbs = resolve(input), outAbs = resolve(output);
  const size = await probeSize(inAbs);
  const assPath = resolve(outAbs.replace(/\.\w+$/, '') + '.kf.ass');
  writeFileSync(assPath, buildKaraokeAss(narration || [], size, style || {}), 'utf8');
  const copied = [];
  for (const f of [regularFont(), boldFont()]) {
    const d = join(dirname(assPath), basename(f));
    try { copyFileSync(f, d); copied.push(d); } catch { /* ignore */ }
  }
  const hasA = await probeHasAudio(inAbs);
  const aargs = hasA ? ['-c:a', 'copy'] : [];
  await run(['-y', '-i', inAbs, '-vf', `ass=${basename(assPath)}:fontsdir=.`, '-r', '30',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', ...aargs, outAbs],
  { cwd: dirname(assPath) });
  try { rmSync(assPath, { force: true }); } catch { /* artifact */ }
  for (const c of copied) { try { rmSync(c, { force: true }); } catch { /* font copy */ } }
  return outAbs;
}

// ---- Smart-crop reframe (follows the action) ------------------------------

// Pure: piecewise-linear ffmpeg expression in `t` from points [{t,v}] (sorted). Holds the first/last
// value outside the range. Mirrors buildVolumeExpr but for an arbitrary value.
export function piecewiseExpr(points) {
  const p = [...(points || [])].sort((a, b) => a.t - b.t);
  if (!p.length) return '0';
  if (p.length === 1) return p[0].v.toFixed(2);
  let expr = p[p.length - 1].v.toFixed(2);
  for (let i = p.length - 2; i >= 0; i--) {
    const a = p[i], b = p[i + 1];
    const dt = Math.max(1e-3, b.t - a.t);
    const seg = `(${a.v.toFixed(2)}+(${(b.v - a.v).toFixed(2)})*(t-${a.t.toFixed(3)})/${dt.toFixed(3)})`;
    expr = `if(lt(t,${b.t.toFixed(3)}),${seg},${expr})`;
  }
  return expr;
}

// Smart 9:16 (or any portrait/narrow aspect) reframe that FOLLOWS the action: a full-height crop
// window panned horizontally to keep the focus (from rect-tagged events) centered, then scaled to
// the target aspect. `focus` = [{t, cx}] in source pixels (event centers). Falls back to centered
// when focus is empty. For wider-than-source targets it just centers (no crop benefit).
export async function smartReframe(input, output, aspect, { focus = [], fps = 30, ease = true } = {}) {
  const src = await probeSize(input);
  const [aw, ah] = String(aspect).split(/[:x/]/).map(Number);
  const ar = aw / ah;
  const even = (n) => { n = Math.max(2, Math.round(n)); return n % 2 ? n + 1 : n; };
  // Portrait/narrower-than-source → crop a full-height window and pan x. Else fall back to padding.
  if (ar >= src.w / src.h) return reframe(input, output, aspect, { fps });
  const cropW = even(Math.min(src.w, src.h * ar));
  const half = cropW / 2;
  const pts = (focus || []).map((f) => ({ t: f.t, v: Math.max(half, Math.min(src.w - half, f.cx)) }));
  const xExpr = pts.length ? piecewiseExpr(pts.map((p) => ({ t: p.t, v: p.v - half })))
    : String(Math.round((src.w - cropW) / 2));
  const hasA = await probeHasAudio(input);
  // crop x supports a per-frame expression; scale to a clean target keeping the 9:16 ratio.
  const outH = even(src.h), outW = even(outH * ar);
  const filter = `crop=w=${cropW}:h=${src.h}:x='${xExpr}':y=0,scale=${outW}:${outH}`;
  const map = hasA ? ['-map', '0:a?'] : [];
  const ac = hasA ? ['-c:a', 'aac', '-b:a', '160k'] : [];
  void ease;
  return run(['-y', '-i', input, '-vf', filter, ...map, '-r', String(fps),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', ...ac, output]);
}

// Build a contact sheet, auto-spreading frames over the clip when `times` isn't given.
// Output defaults to contact.png next to the video. Returns { out, times }.
export async function autoContactSheet(input, { times, out, cols = 4 } = {}) {
  let t = times;
  if (!t || !t.length) {
    const dur = await probeDuration(input).catch(() => 12);
    const n = 8;
    t = Array.from({ length: n }, (_, i) => +((dur * (i + 0.5)) / n).toFixed(2));
  }
  const output = out || join(dirname(input), 'contact.png');
  await contactSheet(input, t, output, { cols });
  return { out: output, times: t };
}

// ---- Captions / SRT -------------------------------------------------------

const srtTime = (s) => {
  const ms = Math.max(0, Math.round(s * 1000));
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:` +
    `${p(Math.floor((ms % 60000) / 1000))},${p(ms % 1000, 3)}`;
};

// Caption events ([{t,text}]) → cues [{start,end,text}]. Each non-empty caption lasts until
// the next event's time (or `duration`); empty-text events just clear/end the previous one.
function toCues(events, duration) {
  const evs = [...(events || [])].sort((a, b) => a.t - b.t);
  const cues = [];
  for (let i = 0; i < evs.length; i++) {
    const { t, text } = evs[i];
    if (!text) continue;
    const end = i + 1 < evs.length ? evs[i + 1].t : duration;
    if (end > t) cues.push({ start: t, end, text });
  }
  return cues;
}

// Turn caption events into an SRT string.
export function buildSrt(events, duration) {
  return toCues(events, duration).map((c, i) =>
    `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');
}

// ---- ASS (styled subtitles: stroke instead of box, fades) ------------------

// '#RRGGBB' → ASS '&HAABBGGRR' (ASS stores colour as BGR and alpha INVERTED: 00=opaque,
// FF=transparent). `alpha` is a 0..255 byte (0 = fully opaque).
function hexToAss(hex, alpha = 0) {
  const h = String(hex).replace('#', '').padStart(6, '0');
  const r = h.slice(0, 2), g = h.slice(2, 4), b = h.slice(4, 6);
  const a = Math.max(0, Math.min(255, alpha)).toString(16).padStart(2, '0');
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

// ASS timestamp: H:MM:SS.cs (centiseconds).
const assTime = (s) => {
  const cs = Math.max(0, Math.round(s * 100));
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${Math.floor(cs / 360000)}:${p(Math.floor((cs % 360000) / 6000))}:` +
    `${p(Math.floor((cs % 6000) / 100))}.${p(cs % 100)}`;
};

// Build a styled .ass from caption events. Default look = "trazo limpio": white text, dark
// stroke, no box, soft shadow, and a {\fad()} fade-in/out per cue. Sizes/margins are authored
// against an 800px-tall reference (PlayResY) so they look the same regardless of capture scale
// (libass scales the reference up to the real video). `style` overrides any default.
export function buildAss(events, duration, style = {}, size = {}) {
  const s = {
    font: defaultFontName(), fontSize: 24, color: '#FFFFFF', outlineColor: '#101010',
    outline: 2, shadow: 0.5, shadowColor: '#000000', shadowAlpha: 0x60,
    bold: false, alignment: 2, marginV: 48, marginL: 64, marginR: 64,
    fadeIn: 200, fadeOut: 200, slideUp: 0, playResY: 800,
    ...style,
  };
  const refH = s.playResY;
  const refW = Math.round(((size.w || 1280) / (size.h || 800)) * refH);
  const primary = hexToAss(s.color, 0);
  const outlineCol = hexToAss(s.outlineColor, 0);
  const backCol = hexToAss(s.shadowColor, s.shadowAlpha);
  const bold = s.bold ? -1 : 0;
  const head =
`[Script Info]
ScriptType: v4.00+
PlayResX: ${refW}
PlayResY: ${refH}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${s.font},${s.fontSize},${primary},&H000000FF,${outlineCol},${backCol},${bold},0,0,0,100,100,0,0,1,${s.outline},${s.shadow},${s.alignment},${s.marginL},${s.marginR},${s.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const cx = Math.round(refW / 2);
  const yBottom = refH - s.marginV;
  const lines = toCues(events, duration).map((c) => {
    const durMs = Math.max(0, (c.end - c.start) * 1000);
    const fin = Math.round(Math.min(s.fadeIn, durMs));
    const fout = Math.round(Math.min(s.fadeOut, Math.max(0, durMs - fin)));
    let tags = `{\\fad(${fin},${fout})`;
    if (s.slideUp > 0) tags += `\\move(${cx},${yBottom + s.slideUp},${cx},${yBottom},0,${fin})`;
    tags += '}';
    const text = String(c.text).replace(/\r?\n/g, '\\N');
    return `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${tags}${text}`;
  });
  return head + lines.join('\n') + '\n';
}

// Draw absolutely-positioned, styled text onto a WxH canvas for the whole `duration` — a libass
// replacement for the `drawtext` filter. drawtext is ABSENT from the bundled Linux ffmpeg-static
// build: ffmpeg 7.0's drawtext gained a hard dependency on libharfbuzz, which the John Van Sickle
// static build omits (it ships libfreetype + libass but not harfbuzz), so the filter is compiled
// out. libass IS bundled on every platform, so the intro card and contact-sheet labels render the
// same everywhere with the binary we ship. PlayRes is set to WxH, so x/y are in real video pixels.
// Each line: { text, x, y, an=8, font, fontSize, color, alpha, bold, outline, outlineColor, shadow,
//   box, boxColor, boxAlpha, boxPad, fade:[inMs,outMs] }. `an` is the libass numpad alignment of the
// \pos anchor (8=top-center like drawtext's x=(w-tw)/2/y=top, 7=top-left, 5=middle).
export function buildPosAss(lines, { width, height, duration }) {
  const styles = [];
  const events = [];
  lines.forEach((ln, i) => {
    const fam = ln.font || defaultFontName();
    const fs = ln.fontSize || 32;
    const primary = hexToAss(ln.color || '#FFFFFF', ln.alpha ?? 0);
    const bold = ln.bold ? -1 : 0;
    const an = ln.an ?? 8;
    let borderStyle, outline, outlineCol, backCol, shadow;
    if (ln.box) {
      borderStyle = 3;                                              // opaque box behind the text
      outline = ln.boxPad ?? 8;                                    // box padding around the glyphs
      backCol = hexToAss(ln.boxColor || '#000000', ln.boxAlpha ?? 0x73);
      outlineCol = backCol;
      shadow = 0;
    } else {
      borderStyle = 1;                                             // plain outline + shadow
      outline = ln.outline ?? 0;
      outlineCol = hexToAss(ln.outlineColor || '#000000', 0);
      backCol = hexToAss('#000000', 0x80);
      shadow = ln.shadow ?? 0;
    }
    styles.push(`Style: L${i},${fam},${fs},${primary},&H000000FF,${outlineCol},${backCol},` +
      `${bold},0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},${an},0,0,0,1`);
    const [fin = 0, fout = 0] = ln.fade || [];
    const fad = (fin || fout) ? `\\fad(${Math.round(fin)},${Math.round(fout)})` : '';
    const text = String(ln.text).replace(/\r?\n/g, '\\N');
    events.push(`Dialogue: ${i},0:00:00.00,${assTime(duration)},L${i},,0,0,0,,` +
      `{\\pos(${Math.round(ln.x)},${Math.round(ln.y)})${fad}}${text}`);
  });
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${Math.round(width)}
PlayResY: ${Math.round(height)}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styles.join('\n')}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join('\n')}
`;
}

// Write an .srt next to/alongside the video (reads `<input>.captions.json` if no
// `captions` passed). Useful on its own (upload as a sidecar track) or to burn.
export async function writeSrt(input, output, { captions } = {}) {
  let events = captions;
  if (!events) {
    try { events = JSON.parse(readFileSync(`${input}.captions.json`, 'utf8')).captions; }
    catch { events = []; }
  }
  const dur = await probeDuration(input);
  writeFileSync(output, buildSrt(events, dur), 'utf8');
  return output;
}

// Burn captions into the video. NOTE: caption times match the ORIGINAL (un-sped) clip — burn
// over the raw webm/mp4, not over an idle-sped output. Run ffmpeg with cwd=subtitle dir so the
// filter only needs the basename (sidesteps Windows drive-colon escaping).
//
//   style as an OBJECT (or omitted) → styled .ass path: clean stroke, no box, fades. Default.
//   style as a STRING               → legacy force_style over an SRT (back-compat).
export async function burnSubs(input, output, { captions, srt, style } = {}) {
  // Absolute paths: ffmpeg runs with cwd=subtitle dir, so relative -i/output would break.
  const inAbs = resolve(input);
  const outAbs = resolve(output);

  // Legacy path: a force_style string, or a pre-supplied SRT to render with the old box style.
  if (typeof style === 'string' || srt) {
    const srtPath = resolve(srt || outAbs.replace(/\.\w+$/, '') + '.srt');
    if (!srt) await writeSrt(inAbs, srtPath, { captions });
    const defStyle = 'Fontsize=20,PrimaryColour=&H00FFFFFF&,BorderStyle=3,Outline=1,' +
      'Shadow=0,BackColour=&H99000000&,MarginV=36,Alignment=2';
    const force = (typeof style === 'string' ? style : defStyle).replace(/'/g, '');
    const filter = `subtitles=${basename(srtPath)}:force_style='${force}'`;
    return run(['-y', '-i', inAbs, '-vf', filter, '-r', '30',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', outAbs],
    { cwd: dirname(srtPath) });
  }

  // Default path: generate a styled .ass (stroke + fades) and burn it with libass.
  const st = style || {};
  let events = captions;
  if (!events) {
    try { events = JSON.parse(readFileSync(`${inAbs}.captions.json`, 'utf8')).captions; }
    catch { events = []; }
  }
  const [dur, size] = await Promise.all([probeDuration(inAbs), probeSize(inAbs)]);
  const assPath = resolve(outAbs.replace(/\.\w+$/, '') + '.ass');
  writeFileSync(assPath, buildAss(events, dur, st, size), 'utf8');
  // Make fonts discoverable by libass without relying on OS-installed fonts: copy them next to the
  // .ass and point fontsdir at the cwd ('.'), which also sidesteps the Windows drive-colon that
  // would break the filter's ':'-separated options. Bundled Inter (regular + bold) is always made
  // available so the default `Fontname: Inter` resolves on any platform; a user `style.fontFile`
  // (paired with its own `style.font` family name) is added on top.
  const fontFiles = [regularFont(), boldFont()];
  if (st.fontFile && existsSync(resolve(st.fontFile))) fontFiles.push(resolve(st.fontFile));
  const copied = [];
  for (const f of fontFiles) {
    const dest = join(dirname(assPath), basename(f));
    try { copyFileSync(f, dest); copied.push(dest); } catch { /* ignore */ }
  }
  const filter = `ass=${basename(assPath)}:fontsdir=.`;
  await run(['-y', '-i', inAbs, '-vf', filter, '-r', '30',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', outAbs],
  { cwd: dirname(assPath) });
  // Drop the build artifacts (the .ass and the font copies) — they're only needed during the burn.
  try { rmSync(assPath, { force: true }); } catch { /* the .ass is just a build artifact */ }
  for (const c of copied) { try { rmSync(c, { force: true }); } catch { /* font copy is disposable */ } }
  return outAbs;
}

// Pure, ffmpeg-free internals exposed ONLY for unit tests (not part of the public API).
export const __test = { toCues, hexToAss, srtTime, assTime, buildVolumeExpr, familyOf };
