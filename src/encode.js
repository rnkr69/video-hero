import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import ffmpegPath from 'ffmpeg-static';

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
export async function speedupIdle(input, output, {
  idle, speed = 4, minIdle = 0.7, floor = 0.5, fps = 30,
} = {}) {
  let ranges = idle;
  if (!ranges) {
    try { ranges = JSON.parse(readFileSync(`${input}.idle.json`, 'utf8')).idle; }
    catch { ranges = []; }
  }
  const dur = await probeDuration(input);

  // Normalize: clip to [0,dur], keep only spans worth speeding, sort, drop overlaps.
  const idleSpans = (ranges || [])
    .map(([a, b]) => [Math.max(0, a), Math.min(dur, b)])
    .filter(([a, b]) => b - a >= minIdle)
    .sort((p, q) => p[0] - q[0]);

  // Walk the timeline, alternating active (1x) and idle (sped) segments.
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
  const parts = segs.filter((g) => g.b - g.a > 0.02);

  // No idle worth compressing → just transcode straight through.
  if (parts.length <= 1) {
    return run(['-y', '-i', input, '-r', String(fps),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', output]);
  }

  const n = parts.length;
  const splitOuts = parts.map((_, i) => `[s${i}]`).join('');
  const chains = parts.map((g, i) =>
    `[s${i}]trim=start=${g.a.toFixed(3)}:end=${g.b.toFixed(3)},setpts=(PTS-STARTPTS)/${g.speed.toFixed(4)}[v${i}]`);
  const concat = parts.map((_, i) => `[v${i}]`).join('') + `concat=n=${n}:v=1:a=0[out]`;
  const filter = `[0:v]split=${n}${splitOuts};${chains.join(';')};${concat}`;

  return run(['-y', '-i', input, '-filter_complex', filter, '-map', '[out]', '-r', String(fps),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', output]);
}

// Extract several frames and tile them into ONE image for fast visual review.
// This is the core of the Claude Code self-verification loop: one Read of the
// contact sheet shows cursor / typing / zoom / timing across the whole clip.
export async function contactSheet(input, times, output, {
  cols, scale = 640, label = true, font = 'C:/Windows/Fonts/segoeui.ttf',
} = {}) {
  if (!Array.isArray(times) || times.length === 0) throw new Error('contactSheet: pass a non-empty times[] array');
  const n = times.length;
  const ncols = cols || Math.ceil(Math.sqrt(n));
  const nrows = Math.ceil(n / ncols);
  const dir = dirname(output);
  const stem = basename(output).replace(/\.(png|jpg|jpeg)$/i, '');
  const pad = (i) => String(i).padStart(2, '0');
  // The numbered tiles are throwaway intermediates — clear them once the grid is built so they
  // don't pile up in out/ (this was the main source of clutter).
  const rmTiles = () => { for (let i = 0; i < n; i++) { try { rmSync(resolve(join(dir, `${stem}-tile-${pad(i)}.png`)), { force: true }); } catch { /* ignore */ } } };
  const inAbs = resolve(input);
  // Stamp each frame with its timestamp via drawtext. Run ffmpeg with cwd=font dir so
  // we pass only the font basename (sidesteps Windows drive-colon escaping). Disabled
  // automatically if the font isn't found (keeps the sheet working everywhere).
  const doLabel = label && existsSync(font);
  // 1) extract each requested timestamp to a numbered, downscaled tile.
  for (let i = 0; i < n; i++) {
    const tile = resolve(join(dir, `${stem}-tile-${pad(i)}.png`));
    let vf = `scale=${scale}:-1`;
    let opts = {};
    if (doLabel) {
      vf += `,drawtext=fontfile=${basename(font)}:text='${times[i].toFixed(2)}s':` +
        'x=12:y=12:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=8';
      opts = { cwd: dirname(font) };
    }
    await run(['-y', '-ss', String(times[i]), '-i', inAbs, '-frames:v', '1', '-vf', vf, tile], opts);
  }
  // A single frame needs no grid — just emit it.
  if (n === 1) {
    copyFileSync(resolve(join(dir, `${stem}-tile-00.png`)), resolve(output));
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

const firstFont = (cands) => cands.find((f) => existsSync(f)) || cands[0];
// Escape inline drawtext text: backslash, the option separator ':' and ',', and swap raw
// apostrophes for a typographic one (sidesteps filtergraph single-quote escaping entirely).
const dtText = (t) => String(t)
  .replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/,/g, '\\,').replace(/'/g, '’');

// Compose an intro card 100% with ffmpeg: solid background, optional centered logo, title and
// subtitle (drawtext), fade-in/out and an optional subtle zoom push-in. Carries an audio track
// (silent, or `music` faded out) so it concatenates cleanly with the demo. Built at WxH so it
// matches the target video exactly.
export function buildIntroFfmpeg(opts = {}) {
  const { out, logo, title = '', subtitle = '', bg = '#0B0F1A',
    animation = 'fade-zoom', music, width = 1280, height = 800, fps = 30 } = opts;
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
  // Run with cwd=fonts dir and reference fonts by basename (sidesteps the Windows drive-colon
  // that drawtext's ':'-separated options can't parse) — same trick as contactSheet.
  const fontFileB = firstFont(['C:/Windows/Fonts/segoeuib.ttf', 'C:/Windows/Fonts/segoeui.ttf']);
  const fontFileR = firstFont(['C:/Windows/Fonts/segoeui.ttf', 'C:/Windows/Fonts/arial.ttf']);
  const fontDir = dirname(fontFileB);
  const chain = [];
  if (title) {
    chain.push(`drawtext=fontfile=${basename(fontFileB)}:text=${dtText(title)}:fontcolor=white:` +
      `fontsize=${Math.round(H * 0.075)}:x=(w-text_w)/2:y=${Math.round(H * 0.54)}`);
  }
  if (subtitle) {
    chain.push(`drawtext=fontfile=${basename(fontFileR)}:text=${dtText(subtitle)}:fontcolor=white@0.82:` +
      `fontsize=${Math.round(H * 0.036)}:x=(w-text_w)/2:y=${Math.round(H * 0.66)}`);
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
  return run(['-y', ...inputs, '-filter_complex', parts.join(';'),
    '-map', '[vout]', '-map', aLabel, '-t', dur.toFixed(3),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', resolve(out)], { cwd: fontDir });
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
    font: 'Segoe UI', fontSize: 24, color: '#FFFFFF', outlineColor: '#101010',
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
  // For a non-installed font, copy it next to the .ass and point fontsdir at the cwd ('.'),
  // avoiding the Windows drive-colon that would break the filter's ':'-separated options.
  let fontsOpt = '';
  if (st.fontFile && existsSync(resolve(st.fontFile))) {
    try { copyFileSync(resolve(st.fontFile), join(dirname(assPath), basename(st.fontFile))); } catch { /* ignore */ }
    fontsOpt = ':fontsdir=.';
  }
  const filter = `ass=${basename(assPath)}${fontsOpt}`;
  await run(['-y', '-i', inAbs, '-vf', filter, '-r', '30',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', outAbs],
  { cwd: dirname(assPath) });
  try { rmSync(assPath, { force: true }); } catch { /* the .ass is just a build artifact */ }
  return outAbs;
}
