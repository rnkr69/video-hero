// Pure spec helpers in run.js: env substitution, step slicing, arg normalisation,
// option mapping and the preflight host-mismatch warnings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../../src/run.js';

const { subEnv, sliceSteps, norm, sessionOpts, preflight } = __test;

test('subEnv substitutes ${VAR} from the environment', () => {
  process.env.DR_TEST_VAR = 'bar';
  try {
    assert.equal(subEnv('${DR_TEST_VAR}/x'), 'bar/x');
  } finally { delete process.env.DR_TEST_VAR; }
});

test('subEnv replaces a missing var with empty string', () => {
  delete process.env.DR_MISSING_VAR;
  assert.equal(subEnv('a${DR_MISSING_VAR}b'), 'ab');
});

test('subEnv recurses into arrays and objects, leaves non-strings alone', () => {
  process.env.DR_TEST_VAR = 'X';
  try {
    assert.deepEqual(
      subEnv({ a: '${DR_TEST_VAR}', b: ['${DR_TEST_VAR}', 1], c: true, d: null }),
      { a: 'X', b: ['X', 1], c: true, d: null },
    );
  } finally { delete process.env.DR_TEST_VAR; }
});

test('sliceSteps returns the same array when no range is given', () => {
  const steps = [{ a: 1 }, { b: 2 }];
  assert.equal(sliceSteps(steps, null, null), steps); // same reference, no copy
});

test('sliceSteps is 1-based inclusive', () => {
  const steps = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(sliceSteps(steps, 2, 4), ['b', 'c', 'd']);
  assert.deepEqual(sliceSteps(steps, 3, null), ['c', 'd', 'e']); // from only
  assert.deepEqual(sliceSteps(steps, null, 2), ['a', 'b']);      // to only
});

test('norm wraps a bare string as { sel }', () => {
  assert.deepEqual(norm('button.send'), { sel: 'button.send' });
  assert.deepEqual(norm({ sel: 'x', ms: 3 }), { sel: 'x', ms: 3 });
  assert.deepEqual(norm(undefined), {});
  assert.deepEqual(norm(null), {});
});

test('sessionOpts maps spec keys (out→outDir, route→routes) with defaults', () => {
  assert.equal(sessionOpts({}).outDir, 'out');
  const o = sessionOpts({ out: 'dist', width: 100, route: [{ url: 'x' }], waitTimeout: 5 });
  assert.equal(o.outDir, 'dist');
  assert.equal(o.width, 100);
  assert.deepEqual(o.routes, [{ url: 'x' }]);
  assert.equal(o.waitTimeout, 5);
});

test('preflight stays silent without a url or APP_URL', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const prev = process.env.APP_URL;
  delete process.env.APP_URL;
  try {
    preflight({});
    preflight({ url: 'http://localhost:4317' }); // no APP_URL to compare against
    assert.equal(warn.mock.callCount(), 0);
  } finally { if (prev !== undefined) process.env.APP_URL = prev; }
});

test('preflight warns on the 127.0.0.1 ↔ localhost cookie trap', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const prev = process.env.APP_URL;
  process.env.APP_URL = 'http://127.0.0.1:4317';
  try {
    preflight({ url: 'http://localhost:4317' });
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0], /trampa 127\.0\.0\.1/);
  } finally {
    if (prev !== undefined) process.env.APP_URL = prev; else delete process.env.APP_URL;
  }
});

test('preflight does not warn when hosts match', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const prev = process.env.APP_URL;
  process.env.APP_URL = 'http://localhost:4317';
  try {
    preflight({ url: 'http://localhost:4317' });
    assert.equal(warn.mock.callCount(), 0);
  } finally {
    if (prev !== undefined) process.env.APP_URL = prev; else delete process.env.APP_URL;
  }
});
