// Pure editing helpers: idle/ramp speed plans, piecewise expressions, karaoke ASS. No ffmpeg.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idleSegments, buildSpeedPlan, piecewiseExpr, buildKaraokeAss, buildProgressBarAss } from '../../src/encode.js';

test('idleSegments interleaves active 1x with sped idle spans', () => {
  const segs = idleSegments([[2, 5]], 10, { speed: 4, minIdle: 0.7, floor: 0.5 });
  assert.deepEqual(segs.map((s) => [s.a, s.b, +s.speed.toFixed(2)]), [
    [0, 2, 1], [2, 5, 4], [5, 10, 1],
  ]);
});

test('idleSegments drops spans shorter than minIdle and clamps to [0,dur]', () => {
  assert.deepEqual(idleSegments([[1, 1.3]], 8, { minIdle: 0.7 }), [{ a: 0, b: 8, speed: 1 }]);
  const segs = idleSegments([[-2, 3]], 5, { speed: 2, minIdle: 0.7, floor: 0.5 });
  assert.equal(segs[0].a, 0); // clamped
});

test('idleSegments never shrinks an idle span below floor', () => {
  // 1s idle at speed 4 would be 0.25s, but floor=0.5 caps it → effective speed 2.
  const segs = idleSegments([[1, 2]], 5, { speed: 4, minIdle: 0.7, floor: 0.5 });
  const idle = segs.find((s) => s.a === 1);
  assert.equal(+idle.speed.toFixed(2), 2);
});

test('buildSpeedPlan slows windows around matching beats, base speed elsewhere', () => {
  const plan = buildSpeedPlan([{ t: 2, kind: 'click' }], 10, { base: 1.4, slowmo: 0.5, at: ['click'], window: 0.6 });
  assert.deepEqual(plan.map((s) => [+s.a.toFixed(2), +s.b.toFixed(2), s.speed]), [
    [0, 1.4, 1.4], [1.4, 2.6, 0.5], [2.6, 10, 1.4],
  ]);
});

test('buildSpeedPlan with no matching beats is one base-speed segment', () => {
  assert.deepEqual(buildSpeedPlan([{ t: 1, kind: 'type' }], 6, { base: 1.5, at: ['click'] }),
    [{ a: 0, b: 6, speed: 1.5 }]);
});

test('buildSpeedPlan merges overlapping slow windows', () => {
  const plan = buildSpeedPlan(
    [{ t: 2, kind: 'click' }, { t: 2.5, kind: 'click' }], 8,
    { base: 1.4, slowmo: 0.5, at: ['click'], window: 0.6 });
  const slow = plan.filter((s) => s.speed === 0.5);
  assert.equal(slow.length, 1);               // 1.4..3.1 merged into one window
  assert.equal(+slow[0].a.toFixed(2), 1.4);
  assert.equal(+slow[0].b.toFixed(2), 3.1);
});

test('piecewiseExpr is a constant for one point and interpolates for many', () => {
  assert.equal(piecewiseExpr([{ t: 0, v: 42 }]), '42.00');
  const expr = piecewiseExpr([{ t: 0, v: 0 }, { t: 2, v: 100 }]);
  assert.match(expr, /if\(lt\(t,2\.000\)/);
  assert.match(expr, /100\.00/);
});

test('buildKaraokeAss emits per-word \\kf with length-weighted timing', () => {
  const ass = buildKaraokeAss([{ t: 1, text: 'hola mundo', duration: 1 }]);
  const d = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
  assert.equal(d.length, 1);
  assert.match(d[0], /0:00:01\.00,0:00:02\.00/);  // spans [t, t+duration]
  assert.match(d[0], /\\kf44\}hola/);             // 4/9 of 100cs
  assert.match(d[0], /\\kf56\}mundo/);            // remainder
});

test('buildKaraokeAss skips captions with no text or zero duration', () => {
  assert.equal(buildKaraokeAss([{ t: 1, text: '', duration: 1 }]).includes('Dialogue:'), false);
  assert.equal(buildKaraokeAss([{ t: 1, text: 'x', duration: 0 }]).includes('Dialogue:'), false);
});

test('buildProgressBarAss grows the bar width across discrete steps (libass, not drawbox)', () => {
  const ass = buildProgressBarAss(10, { w: 1000, h: 500 }, { steps: 10, height: 5, pos: 'bottom', color: '#6C5CE7' });
  const d = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
  assert.equal(d.length, 10);
  assert.match(d[0], /\\pos\(0,495\)/);     // bottom: H - height
  assert.match(d[0], /\\1c&HE75C6C&/);      // #6C5CE7 → BGR
  assert.match(d[0], /l 100 0/);            // first slice ≈ 10% of 1000
  assert.match(d[9], /l 1000 0/);           // last slice = full width
});
