// matchUrl — the route-rule glob/substring matcher (first-match-wins interception).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../../src/recorder.js';

const { matchUrl } = __test;

test('a pattern without * is a substring match', () => {
  assert.equal(matchUrl('/api/dashboard', 'http://x/api/dashboard?y=1'), true);
  assert.equal(matchUrl('/nope', 'http://x/api/dashboard'), false);
});

test('* is a wildcard, anchored at both ends', () => {
  assert.equal(matchUrl('http://x/*', 'http://x/anything'), true);  // prefix
  assert.equal(matchUrl('*.json', 'http://x/a.json'), true);        // suffix
  assert.equal(matchUrl('*/api/*', 'http://x/api/y'), true);        // middle
});

test('regex metacharacters in the pattern are escaped', () => {
  // The '.' is literal, so it must NOT act as "any char".
  assert.equal(matchUrl('*.json', 'http://x/aXjson'), false);
  // The '+' is literal too.
  assert.equal(matchUrl('a+b*', 'a+bxyz'), true);
  assert.equal(matchUrl('a+b*', 'aXbxyz'), false);
});
