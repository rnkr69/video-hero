// bin/demo-recorder.js flag parser + help text (doc-rot guard).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../../bin/demo-recorder.js';

const { parse, HELP } = __test;

test('--no-encode flag and positionals in order', () => {
  const { positionals, flags } = parse(['run', 'x.yml', '--no-encode']);
  assert.deepEqual(positionals, ['run', 'x.yml']);
  assert.deepEqual(flags, { noEncode: true });
});

test('--from / --to as separate tokens, coerced to numbers', () => {
  assert.deepEqual(parse(['--from', '2', '--to', '4']).flags, { from: 2, to: 4 });
});

test('--from= / --to= inline forms', () => {
  assert.deepEqual(parse(['--from=3', '--to=5']).flags, { from: 3, to: 5 });
});

test('--all and --keep (both token and inline)', () => {
  assert.deepEqual(parse(['--all', '--keep', '5']).flags, { all: true, keep: 5 });
  assert.deepEqual(parse(['--keep=2']).flags, { keep: 2 });
});

test('flags interleaved with positionals keep positional order', () => {
  const { positionals, flags } = parse(['a', '--from', '1', 'b']);
  assert.deepEqual(positionals, ['a', 'b']);
  assert.equal(flags.from, 1);
});

test('HELP documents every command (doc-rot guard)', () => {
  for (const cmd of ['run', 'record', 'encode', 'probe', 'frames', 'clean', 'tracks', 'login', 'mock']) {
    assert.ok(HELP.includes(cmd), `HELP should mention "${cmd}"`);
  }
});
