// resolveTrack / bundledTracks — alias + fuzzy resolution against the engine's bundled
// audio/bg/ (real committed assets).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolveTrack, bundledTracks, defaultTrack } from '../../src/tracks.js';

test('bundledTracks lists committed music with kebab slugs', () => {
  const tracks = bundledTracks();
  assert.ok(tracks.length >= 1);
  for (const t of tracks) {
    assert.equal(typeof t.file, 'string');
    assert.match(t.slug, /^[a-z0-9-]+$/); // slug strips the leading track number
  }
  assert.ok(tracks.some((t) => t.slug.includes('ambient')));
});

test('defaultTrack prefers an ambient bed and returns an absolute path', () => {
  const d = defaultTrack();
  assert.ok(d);
  assert.match(d.toLowerCase(), /ambient/);
});

test('empty track resolves to the default bed', () => {
  assert.equal(resolveTrack(''), defaultTrack());
  assert.equal(resolveTrack(undefined), defaultTrack());
});

test('exact alias resolves', () => {
  assert.match(resolveTrack('ambient-gold').toLowerCase(), /ambient-gold/);
});

test('fuzzy substring resolves', () => {
  assert.match(resolveTrack('ambient').toLowerCase(), /ambient/);
});

test('a real existing path passes through', () => {
  const self = fileURLToPath(import.meta.url);
  assert.equal(resolveTrack(self), self); // existsSync(direct) wins regardless of extension
});

test('an unknown track throws, listing the bundled options', () => {
  assert.throws(() => resolveTrack('definitely-not-a-real-track-xyz'), /no encontrada/);
});
