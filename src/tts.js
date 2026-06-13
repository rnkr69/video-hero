// Pluggable text-to-speech with deterministic caching.
//
// Providers:
//   'edge'   — Microsoft Edge neural voices via @andresaya/edge-tts. Free, no API key,
//              Node-native, high-quality Spanish (default es-ES-ElviraNeural). Uses an
//              undocumented MS endpoint, so it can break — iterate if so.
//   'openai' — any OpenAI-compatible /v1/audio/speech endpoint. Covers a local
//              Chatterbox-TTS-Server (MIT, offline) or OpenAI itself. Set opts.baseUrl.
//
// Every synthesis is cached by hash(provider+voice+rate+pitch+volume+model+text) under
// out/tts-cache/, so re-renders are offline, free and deterministic — generate once.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EdgeTTS } from '@andresaya/edge-tts';
import { probeDuration, muxAudio, mixVoiceAndMusic, toMp4 } from './encode.js';
import { resolveTrack } from './tracks.js';

const DEFAULT_VOICE = 'es-ES-ElviraNeural';

const keyFor = (text, o) => createHash('sha1').update(JSON.stringify({
  p: o.provider || 'edge', v: o.voice || DEFAULT_VOICE,
  r: o.rate || '', pi: o.pitch || '', vol: o.volume || '', m: o.model || '', t: text,
})).digest('hex').slice(0, 16);

// Synthesize one string to a cached mp3; returns its path. Hits the network only on a
// cache miss.
export async function synthesize(text, opts = {}) {
  // Default cache lives OUTSIDE out/ so cleaning out/ between renders doesn't wipe it
  // (the whole point: re-renders stay offline & free).
  const cacheDir = resolve(opts.cacheDir || '.cache/tts');
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  const base = join(cacheDir, keyFor(text, opts));
  const file = `${base}.mp3`;
  if (existsSync(file)) return file;

  const provider = opts.provider || 'edge';
  if (provider === 'edge') {
    const tts = new EdgeTTS();
    await tts.synthesize(text, opts.voice || DEFAULT_VOICE, {
      rate: opts.rate || '+0%', pitch: opts.pitch || '+0Hz', volume: opts.volume || '+0%',
    });
    await tts.toFile(base); // writes `${base}.mp3`
    return file;
  }
  if (provider === 'openai') {
    const baseUrl = opts.baseUrl || 'http://127.0.0.1:8004';
    const res = await fetch(`${baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: opts.model || 'tts-1', voice: opts.voice || 'alloy',
        input: text, response_format: 'mp3',
      }),
    });
    if (!res.ok) throw new Error(`tts(openai) HTTP ${res.status} from ${baseUrl}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    return file;
  }
  throw new Error('unknown tts provider: ' + provider);
}

// Synthesize one audio clip per non-empty caption event. Returns [{t,text,audio,duration}].
export async function narrate(events, opts = {}) {
  const out = [];
  for (const ev of (events || []).filter((e) => e.text)) {
    const audio = await synthesize(ev.text, opts);
    out.push({ t: ev.t, text: ev.text, audio, duration: await probeDuration(audio) });
  }
  return out;
}

// Read caption events and synthesize (cached) one voice clip per caption, returning the
// timeline [{t,text,audio,duration}]. Used to drive both the mux and the music envelope.
export async function getNarration(input, opts = {}) {
  let events = opts.captions;
  if (!events) {
    const src = opts.captionsFrom || input;
    try { events = JSON.parse(readFileSync(`${src}.captions.json`, 'utf8')).captions; }
    catch { events = []; }
  }
  return narrate([...events].sort((a, b) => a.t - b.t), opts);
}

// Build a music-ducking volume envelope (keyframes [{t,vol}]) from the TTS timeline.
// Music sits at `full`, ducks to `duck` around each clip ([t-lead, t+dur+tail]); windows
// closer than `gapRaise` stay ducked (merged), so the bed only rises back to `full` in gaps
// of at least `gapRaise` seconds and after the last clip. `ramp` is the up/down fade length.
// `offset` shifts every voice time (so the bed can span an intro prepended before the demo).
export function musicEnvelope(narration, dur, m = {}, offset = 0) {
  const full = m.full ?? 0.85, duck = m.duck ?? 0.16;
  const lead = m.lead ?? 1.2, tail = m.tail ?? 0.8;
  const gapRaise = m.gapRaise ?? 3.0, ramp = m.ramp ?? 0.4;

  const wins = (narration || [])
    .map((n) => [Math.max(0, n.t + offset - lead), Math.min(dur, n.t + offset + n.duration + tail)])
    .filter(([a, b]) => b > a)
    .sort((p, q) => p[0] - q[0]);
  const merged = [];
  for (const w of wins) {
    const last = merged[merged.length - 1];
    if (last && w[0] - last[1] < gapRaise) last[1] = Math.max(last[1], w[1]); // gap too short → stay ducked
    else merged.push([...w]);
  }

  const kf = [{ t: 0, vol: full }];
  for (const [a, b] of merged) {
    const aa = Math.max(0, a), bb = Math.min(dur, b);
    const downEnd = Math.min(aa + ramp, bb);
    const upStart = Math.max(bb - ramp, downEnd);
    kf.push({ t: aa, vol: full }, { t: downEnd, vol: duck });
    if (upStart > downEnd) kf.push({ t: upStart, vol: duck });
    kf.push({ t: bb, vol: full });
  }
  kf.push({ t: dur, vol: full });
  return kf.sort((p, q) => p.t - q.t);
}

// Full pipeline: read caption events (from opts.captions or `<captionsFrom|input>.captions.json`),
// synthesize a voiceover per caption, warn if any narration overruns its window, and mux the
// clips onto the video. With `opts.music`, also lay a ducked background-music bed underneath
// (works even with zero captions: a plain music bed at `full` with fades).
export async function narrateVideo(input, output, opts = {}) {
  let events = opts.captions;
  if (!events) {
    const src = opts.captionsFrom || input;
    try { events = JSON.parse(readFileSync(`${src}.captions.json`, 'utf8')).captions; }
    catch { events = []; }
  }
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const narration = await narrate(sorted, opts);
  const music = opts.music;

  if (!narration.length && !music) {
    console.warn('[tts] no hay captions que narrar; genero mp4 sin voz.');
    return toMp4(input, output);
  }

  for (const n of narration) {
    const next = sorted.find((e) => e.t > n.t);          // next caption (incl. empty clears)
    const limit = next ? next.t - n.t : Infinity;        // available window
    if (n.duration > limit + 0.05) {
      console.warn(`[tts] "${n.text.slice(0, 40)}…" dura ${n.duration.toFixed(1)}s y se pasa de su ` +
        `ventana (${limit.toFixed(1)}s). Sube ese hold y re-renderiza (el audio está cacheado).`);
    }
  }

  const voiceTracks = narration.map((n) => ({ path: n.audio, delay: n.t }));

  if (music) {
    const track = resolveTrack(music.track || music.path); // path, bundled name/alias, or default
    const dur = await probeDuration(input);
    const keyframes = musicEnvelope(narration, dur, music);
    return mixVoiceAndMusic(input, output, voiceTracks,
      { path: track, keyframes, duration: dur, fadeIn: music.fadeIn, fadeOut: music.fadeOut }, opts);
  }

  return muxAudio(input, output, voiceTracks, opts);
}
