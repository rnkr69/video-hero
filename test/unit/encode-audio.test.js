// buildVolumeExpr — the piecewise-linear ffmpeg `volume` expression that automates the
// music bed level from keyframes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../../src/encode.js';

const { buildVolumeExpr } = __test;

test('no keyframes → constant 1', () => {
  assert.equal(buildVolumeExpr([]), '1');
  assert.equal(buildVolumeExpr(null), '1');
  assert.equal(buildVolumeExpr(undefined), '1');
});

test('single keyframe → its level fixed to 4 decimals', () => {
  assert.equal(buildVolumeExpr([{ t: 0, vol: 0.5 }]), '0.5000');
  assert.equal(buildVolumeExpr([{ t: 3, vol: 0.85 }]), '0.8500');
});

test('two keyframes → nested if() with linear interpolation', () => {
  const expr = buildVolumeExpr([{ t: 0, vol: 0.85 }, { t: 2, vol: 0.16 }]);
  assert.equal(
    expr,
    'if(lt(t,2.000),(0.8500+(-0.6900)*(t-0.000)/2.000),0.1600)',
  );
});

test('three keyframes nest from the tail inward', () => {
  const expr = buildVolumeExpr([
    { t: 0, vol: 0.85 },
    { t: 1, vol: 0.16 },
    { t: 2, vol: 0.85 },
  ]);
  // Outer guard is the first segment boundary; the inner if() covers the later segment.
  assert.ok(expr.startsWith('if(lt(t,1.000),'));
  assert.ok(expr.includes('if(lt(t,2.000),'));
  assert.ok(expr.endsWith('0.8500))')); // two nested if() → two closing parens
});

test('equal timestamps do not throw (dt floored to avoid a JS divide-by-zero)', () => {
  assert.doesNotThrow(() => buildVolumeExpr([{ t: 1, vol: 0.5 }, { t: 1, vol: 0.2 }]));
});
