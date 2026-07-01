// src/capture.js — the "capture window" feature. Playwright's recordVideo grabs the whole context
// lifecycle (page created → context closed), so the raw ALWAYS carries a loading splash up front, the
// synthetic-cursor choreography before the content, and dead tail at the end. Instead of trimming
// that by hand against fragile anchors, the app declares its content span IN-BAND (a DOM selector or
// a window.__demorecorder.mark('start'|'end') call); the recorder stamps each mark Node-side in the
// SAME clock as clicks/captions/idle (see recorder.js), and here we trim the webm to that window and
// rebase every sidecar to the new zero. Opt-in and 100% backward compatible: no `capture` block → the
// raw is returned untouched.
import { readFileSync, writeFileSync } from 'node:fs';
import { probeDuration, trimWindow } from './encode.js';

// Normalize one marker: a bare string is a selector; an object is { selector } or { event }.
function normMark(name, v) {
  if (v == null) return null;
  if (typeof v === 'string') return { name, selector: v };
  if (typeof v === 'object') {
    if (v.selector) return { name, selector: String(v.selector) };
    if (v.event) return { name, event: String(v.event) };
  }
  return null;
}

// A spec's `capture` block → { marks:[{name,selector?|event?}], pad:{before,after}, closeOnEnd }.
// `marks` is what the in-page bridge receives (it only acts on the selector ones); pad/closeOnEnd
// drive the Node-side trim + early close.
export function normalizeCapture(capture) {
  const c = capture || {};
  const marks = [normMark('start', c.start), normMark('end', c.end)].filter(Boolean);
  const pad = { before: Number(c.pad && c.pad.before) || 0, after: Number(c.pad && c.pad.after) || 0 };
  return { marks, pad, closeOnEnd: c.closeOnEnd !== false };
}

// Resolve the trim window from the stamped marks (video-timeline seconds) and the real duration.
// Never drops the video silently: a missing `start` → no trim; a missing `end` → trim only the head
// and keep the raw's tail. Returns { trim, zero, endEff, length, warnings }.
export function captureWindow(rawMarks, dur, pad = {}) {
  const before = Number(pad.before) || 0;
  const after = Number(pad.after) || 0;
  const startT = rawMarks && rawMarks.start;
  const endT = rawMarks && rawMarks.end;
  const warnings = [];
  if (startT == null) {
    warnings.push('la marca `start` nunca llegó — no recorto (vídeo completo).');
    return { trim: false, warnings };
  }
  const zero = Math.max(0, startT - before);
  let endEff;
  if (endT == null) {
    warnings.push('la marca `end` nunca llegó — recorto el arranque y uso el final del raw.');
    endEff = dur;
  } else {
    endEff = Math.min(dur, endT + after);
  }
  if (endEff <= zero + 0.02) {
    warnings.push('ventana vacía o invertida — no recorto.');
    return { trim: false, warnings };
  }
  return { trim: true, zero, endEff, length: endEff - zero, startT, endT, warnings };
}

// Rebase the sidecars onto the trimmed window: subtract `zero`, clamp to [0, length], drop whatever
// falls outside. Idle spans are clamped at both ends and empties dropped. For captions we also carry
// the last non-empty caption that started at/before the window (clamped to 0), so text already on
// screen when the window opens doesn't vanish. Pure — no ffmpeg, easy to unit-test.
export function rebaseSidecars({ idle, captions, events } = {}, zero, length) {
  const rIdle = (idle || [])
    .map(([a, b]) => [Math.max(0, a - zero), Math.min(length, b - zero)])
    .filter(([a, b]) => b - a > 0.001);

  const rEvents = (events || [])
    .map((e) => ({ ...e, t: e.t - zero }))
    .filter((e) => e.t >= -1e-9 && e.t <= length + 1e-9)
    .map((e) => ({ ...e, t: Math.max(0, e.t) }));

  const capsSorted = [...(captions || [])].sort((a, b) => a.t - b.t);
  const rCaptions = [];
  let carry = null; // last caption starting at/before the window
  for (const c of capsSorted) {
    const t = c.t - zero;
    if (t < -1e-9) { carry = c; continue; }
    if (t > length + 1e-9) break;
    rCaptions.push({ ...c, t: Math.max(0, t) });
  }
  if (carry && carry.text && !(rCaptions[0] && rCaptions[0].t === 0)) {
    rCaptions.unshift({ ...carry, t: 0 });
  }

  return { idle: rIdle, captions: rCaptions, events: rEvents };
}

const readKey = (file, key) => {
  try { return JSON.parse(readFileSync(file, 'utf8'))[key]; } catch { return undefined; }
};
const writeKey = (file, key, val) => {
  if (val && val.length) { try { writeFileSync(file, JSON.stringify({ [key]: val })); } catch { /* non-fatal */ } }
};

// Trim `video` to the capture window and write rebased sidecars next to the trimmed webm. Returns the
// path of the trimmed webm (the new canonical that `encode` consumes), or the original `video` when
// there's nothing to trim. The raw is left in place for debugging.
export async function applyCapture(spec, video) {
  let marks;
  try { marks = JSON.parse(readFileSync(`${video}.capture.json`, 'utf8')); } catch { marks = null; }
  if (!marks) { console.warn('[capture] no se registraron marcas — no recorto.'); return video; }

  const { pad } = normalizeCapture(spec.capture);
  const dur = await probeDuration(video);
  // Marks (and every sidecar) share the recorder's clock, anchored at context creation — the same
  // instant recordVideo starts capturing — so node time ≈ video time and no offset correction is
  // needed. (The raw's probed duration runs a hair short of the total node span because the encoder
  // stops writing frames a beat before context.close finalizes; that's a TAIL effect, not a head
  // offset, so it must not shift the trim start — verified against the contact sheet.)
  const win = captureWindow({ start: marks.start, end: marks.end }, dur, pad);
  for (const w of win.warnings) console.warn('[capture] ' + w);
  if (!win.trim) return video;

  const { zero, endEff, length } = win;
  const out = video.replace(/\.webm$/i, '') + '.win.webm';
  const endLabel = marks.end != null ? `${marks.end.toFixed(2)}s` : '—';
  console.log(`[capture] start=${marks.start.toFixed(2)}s end=${endLabel} → recorte ` +
    `[${zero.toFixed(2)}…${endEff.toFixed(2)}] (${length.toFixed(2)}s)`);
  await trimWindow(video, out, zero, endEff);

  const rebased = rebaseSidecars({
    idle: readKey(`${video}.idle.json`, 'idle'),
    captions: readKey(`${video}.captions.json`, 'captions'),
    events: readKey(`${video}.events.json`, 'events'),
  }, zero, length);
  writeKey(`${out}.idle.json`, 'idle', rebased.idle);
  writeKey(`${out}.captions.json`, 'captions', rebased.captions);
  writeKey(`${out}.events.json`, 'events', rebased.events);
  return out;
}

// Pure helpers exposed ONLY for unit tests (not part of the public API).
export const __test = { normalizeCapture, captureWindow, rebaseSidecars };
