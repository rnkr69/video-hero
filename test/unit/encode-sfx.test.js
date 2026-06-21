// mapSfx — the pure event→SFX-cue mapping behind the SFX stage (no ffmpeg, no I/O).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapSfx } from '../../src/encode.js';

const evs = [
  { t: 1.0, kind: 'click', sel: 'a' },
  { t: 2.0, kind: 'type', sel: 'input' },     // muted by default
  { t: 2.5, kind: 'spotlight', sel: 'b' },    // muted by default (rides along with the zoom)
  { t: 3.0, kind: 'zoom', sel: 'b' },
  { t: 4.0, kind: 'nav', sel: 'c' },
];

test('maps kinds to default SFX names and drops muted kinds', () => {
  const cues = mapSfx(evs);
  assert.deepEqual(cues.map((c) => [c.kind, c.name, c.delay]), [
    ['click', 'click', 1.0],
    ['zoom', 'whoosh', 3.0],
    ['nav', 'click', 4.0],
  ]);
});

test('offset shifts every cue on the timeline (e.g. a prepended intro)', () => {
  const cues = mapSfx(evs, { offset: 2.5 });
  assert.deepEqual(cues.map((c) => c.delay), [3.5, 5.5, 6.5]);
});

test('a negative net delay is clamped to 0', () => {
  const cues = mapSfx([{ t: 0.2, kind: 'click' }], { offset: -1 });
  assert.equal(cues[0].delay, 0);
});

test('per-kind override: a name string, a {name,gain} object, or null to mute', () => {
  const cues = mapSfx(evs, { map: { click: 'pop', zoom: { name: 'swoosh', gain: 0.5 }, nav: null } });
  assert.deepEqual(cues.map((c) => [c.kind, c.name, c.gain]), [
    ['click', 'pop', 0.45],   // default conservative gain
    ['zoom', 'swoosh', 0.5],
  ]);
});

test('zoomOut is muted by default (one whoosh per zoom gesture, on the zoom-in)', () => {
  const cues = mapSfx([{ t: 1, kind: 'zoom' }, { t: 3, kind: 'zoomOut' }]);
  assert.deepEqual(cues.map((c) => c.kind), ['zoom']);
});

test('cooldown drops a same-sound cue that lands within minGap', () => {
  // two clicks 0.2s apart → the second is skipped (same sound still playing).
  const cues = mapSfx([{ t: 1.0, kind: 'click' }, { t: 1.2, kind: 'click' }, { t: 2.0, kind: 'click' }],
    { minGap: 0.3 });
  assert.deepEqual(cues.map((c) => c.delay), [1.0, 2.0]);
});

test('global gain applies when no per-entry gain is set', () => {
  const cues = mapSfx([{ t: 1, kind: 'click' }], { gain: 0.8 });
  assert.equal(cues[0].gain, 0.8);
});

test('a literal sfx event carries its own name through', () => {
  const cues = mapSfx([{ t: 1, kind: 'sfx', name: 'boom' }]);
  assert.deepEqual(cues, [{ name: 'boom', delay: 1, gain: 0.45, kind: 'sfx' }]);
});

test('only[] restricts the cues to a kind whitelist', () => {
  const cues = mapSfx(evs, { only: ['zoom'] });
  assert.deepEqual(cues.map((c) => c.kind), ['zoom']);
});

test('empty / missing events yield no cues', () => {
  assert.deepEqual(mapSfx(), []);
  assert.deepEqual(mapSfx([]), []);
});
