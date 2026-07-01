// Pure capture-window helpers: marker normalization, window resolution, sidecar rebasing. No ffmpeg.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../../src/capture.js';

const { normalizeCapture, captureWindow, rebaseSidecars } = __test;

test('normalizeCapture: string → selector, object → selector|event, and defaults', () => {
  const c = normalizeCapture({ start: 'body[data-state="playing"]', end: { event: 'end' } });
  assert.deepEqual(c.marks, [
    { name: 'start', selector: 'body[data-state="playing"]' },
    { name: 'end', event: 'end' },
  ]);
  assert.deepEqual(c.pad, { before: 0, after: 0 });
  assert.equal(c.closeOnEnd, true);
});

test('normalizeCapture: mixes selector + event, honors pad and closeOnEnd:false', () => {
  const c = normalizeCapture({
    start: { event: 'go' }, end: '.done', pad: { before: 0.5, after: 1 }, closeOnEnd: false,
  });
  assert.deepEqual(c.marks, [{ name: 'start', event: 'go' }, { name: 'end', selector: '.done' }]);
  assert.deepEqual(c.pad, { before: 0.5, after: 1 });
  assert.equal(c.closeOnEnd, false);
});

test('normalizeCapture: missing/garbage markers are dropped', () => {
  assert.deepEqual(normalizeCapture({}).marks, []);
  assert.deepEqual(normalizeCapture({ start: {}, end: 42 }).marks, []); // no selector/event, non-string
});

test('captureWindow: nominal window with pads, clamped to duration', () => {
  const w = captureWindow({ start: 2, end: 6 }, 10, { before: 0.5, after: 0.3 });
  assert.equal(w.trim, true);
  assert.equal(w.zero, 1.5);
  assert.equal(+w.endEff.toFixed(2), 6.3);
  assert.equal(+w.length.toFixed(2), 4.8);
});

test('captureWindow: before-pad never goes below 0; after-pad never exceeds duration', () => {
  const w = captureWindow({ start: 0.2, end: 9.9 }, 10, { before: 1, after: 5 });
  assert.equal(w.zero, 0);        // 0.2 - 1 clamped to 0
  assert.equal(w.endEff, 10);     // 9.9 + 5 clamped to dur
});

test('captureWindow: missing start → no trim + warning', () => {
  const w = captureWindow({ start: null, end: 6 }, 10);
  assert.equal(w.trim, false);
  assert.match(w.warnings[0], /start/);
});

test('captureWindow: missing end → trims head, keeps raw tail + warning', () => {
  const w = captureWindow({ start: 2, end: null }, 10, { after: 1 });
  assert.equal(w.trim, true);
  assert.equal(w.zero, 2);
  assert.equal(w.endEff, 10);     // no end → raw duration
  assert.match(w.warnings[0], /end/);
});

test('captureWindow: inverted/empty window → no trim', () => {
  const w = captureWindow({ start: 8, end: 8.01 }, 10);
  assert.equal(w.trim, false);
});

test('rebaseSidecars: shifts events into window, drops out-of-window, clamps to 0', () => {
  const events = [
    { t: 1.0, kind: 'click' },   // before window (zero=2) → dropped
    { t: 2.0, kind: 'zoom' },    // exactly at zero → t=0
    { t: 3.5, kind: 'type' },    // → 1.5
    { t: 6.5, kind: 'nav' },     // beyond zero+length (2+4=6) → dropped
  ];
  const r = rebaseSidecars({ events }, 2, 4);
  assert.deepEqual(r.events.map((e) => [e.kind, +e.t.toFixed(2)]), [['zoom', 0], ['type', 1.5]]);
});

test('rebaseSidecars: idle spans shift + clamp to [0,length], empties dropped', () => {
  const idle = [
    [0.5, 1.5],   // fully before window → clamps to [0,0] → dropped
    [1.5, 3.0],   // → [0, 1.0]
    [5.0, 7.0],   // → [3.0, 4.0] (clamped to length=4)
  ];
  const r = rebaseSidecars({ idle }, 2, 4);
  assert.deepEqual(r.idle.map((s) => s.map((n) => +n.toFixed(2))), [[0, 1], [3, 4]]);
});

test('rebaseSidecars: captions shift; the last one before the window is carried to t=0', () => {
  const captions = [
    { t: 0.5, text: 'splash' },    // before window → carried (last before zero)
    { t: 3.0, text: 'contenido' }, // → 1.0
    { t: 9.0, text: 'late' },      // beyond window → dropped
  ];
  const r = rebaseSidecars({ captions }, 2, 4);
  assert.deepEqual(r.captions.map((c) => [c.text, +c.t.toFixed(2)]), [['splash', 0], ['contenido', 1]]);
});

test('rebaseSidecars: an empty-text caption before the window is NOT carried (nothing on screen)', () => {
  const captions = [{ t: 0.5, text: '' }, { t: 3.0, text: 'x' }];
  const r = rebaseSidecars({ captions }, 2, 4);
  assert.deepEqual(r.captions.map((c) => [c.text, +c.t.toFixed(2)]), [['x', 1]]);
});

test('rebaseSidecars: undefined inputs yield empty arrays', () => {
  assert.deepEqual(rebaseSidecars(undefined, 0, 5), { idle: [], captions: [], events: [] });
});
