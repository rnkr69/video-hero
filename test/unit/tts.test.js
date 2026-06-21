// musicEnvelope — the pure ducking-keyframe math (no network/ffmpeg).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { musicEnvelope } from '../../src/tts.js';

// Floats like 5 - 1.2 can carry binary noise; compare at 3 decimals.
const round = (kf) => kf.map((k) => ({ t: +k.t.toFixed(3), vol: +k.vol.toFixed(3) }));

test('no narration → flat bed at full from 0 to dur', () => {
  assert.deepEqual(round(musicEnvelope([], 10)), [
    { t: 0, vol: 0.85 },
    { t: 10, vol: 0.85 },
  ]);
});

test('single clip ducks with lead/tail window and ramp edges', () => {
  // clip at t=5 lasting 2s → window [5-1.2, 5+2+0.8] = [3.8, 7.8]; ramp 0.4.
  const kf = round(musicEnvelope([{ t: 5, duration: 2 }], 20));
  assert.deepEqual(kf, [
    { t: 0, vol: 0.85 },
    { t: 3.8, vol: 0.85 },
    { t: 4.2, vol: 0.16 }, // downEnd = 3.8 + ramp
    { t: 7.4, vol: 0.16 }, // upStart = 7.8 - ramp
    { t: 7.8, vol: 0.85 },
    { t: 20, vol: 0.85 },
  ]);
});

test('clips within gapRaise merge into one ducked window', () => {
  // windows [3.8,6.8] and [5.8,8.8] overlap (gap < 3) → single duck region.
  const kf = round(musicEnvelope([{ t: 5, duration: 1 }, { t: 7, duration: 1 }], 20));
  const duckPoints = kf.filter((k) => k.vol === 0.16);
  // One contiguous duck → exactly two duck keyframes (downEnd, upStart).
  assert.equal(duckPoints.length, 2);
  assert.deepEqual(duckPoints.map((k) => k.t), [4.2, 8.4]);
});

test('clips farther apart than gapRaise stay as two windows', () => {
  // windows [3.8,6.8] and [10.8,13.8]; gap 4.0 >= 3 → not merged.
  const kf = round(musicEnvelope([{ t: 5, duration: 1 }, { t: 12, duration: 1 }], 20));
  const risesToFull = kf.filter((k) => k.vol === 0.85).map((k) => k.t);
  // Bed returns to full between the two windows (6.8) and again after (13.8, 20).
  assert.ok(risesToFull.includes(6.8));
  assert.ok(risesToFull.includes(13.8));
});

test('offset shifts every voice window (intro prepended before the demo)', () => {
  const kf = round(musicEnvelope([{ t: 5, duration: 2 }], 20, {}, 3));
  // window now [5+3-1.2, 5+3+2+0.8] = [6.8, 10.8].
  assert.ok(kf.some((k) => k.t === 6.8 && k.vol === 0.85));
  assert.ok(kf.some((k) => k.t === 10.8 && k.vol === 0.85));
});

test('windows are clamped to [0, dur]', () => {
  const kf = round(musicEnvelope([{ t: 0, duration: 1 }], 20));
  assert.equal(kf[0].t, 0);                       // lead can't push before 0
  assert.equal(kf[kf.length - 1].t, 20);          // last keyframe is dur
  assert.ok(kf.every((k) => k.t >= 0 && k.t <= 20));
});

test('m overrides full/duck levels', () => {
  const kf = round(musicEnvelope([{ t: 5, duration: 2 }], 20, { full: 1.0, duck: 0.05 }));
  assert.ok(kf.some((k) => k.vol === 1.0));
  assert.ok(kf.some((k) => k.vol === 0.05));
});

test('keyframes come out sorted by time', () => {
  const kf = musicEnvelope([{ t: 12, duration: 1 }, { t: 5, duration: 1 }], 20);
  const times = kf.map((k) => k.t);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});
