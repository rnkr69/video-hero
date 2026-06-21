// layout.js housekeeping — the isJunk predicate plus the destructive prune/clean ops,
// exercised against throwaway temp dirs (never the repo's out/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pruneRaw, cleanOut, wipeWork, rawDir, workDir } from '../../src/layout.js';
import { __test } from '../../src/layout.js';
import { withTempDir, fakeRecording } from '../helpers/tmp.js';

const { isJunk } = __test;

test('isJunk flags disposable artefacts', () => {
  for (const name of [
    'contact-tile-03.png', 'final-check.png', '_scratch.txt', 'contact.png',
    'contact-page@abc.png', 'demo-cc.mp4', 'hero.novol.mp4', 'hero.mtmp.mp4',
    'subs.ass', 'tts-smoke.mp3', 'intro-title.txt', 'intro-subtitle.txt',
  ]) assert.ok(isJunk(name), `${name} should be junk`);
});

test('isJunk preserves final videos', () => {
  for (const name of ['hero.mp4', 'demo.mp4', 'intro-demo.mp4', 'narrate.gif']) {
    assert.equal(isJunk(name), false, `${name} should be kept`);
  }
});

test('pruneRaw keeps the newest N recordings and deletes the rest with sidecars', () => {
  withTempDir((out) => {
    const raw = rawDir(out);
    fakeRecording(raw, 'a', 1000);
    fakeRecording(raw, 'b', 2000);
    fakeRecording(raw, 'c', 3000);
    fakeRecording(raw, 'd', 4000);
    const removed = pruneRaw(out, 2);
    assert.equal(removed, 6); // 2 oldest × (webm + 2 sidecars)
    const webms = readdirSync(raw).filter((f) => f.endsWith('.webm')).sort();
    assert.deepEqual(webms, ['c.webm', 'd.webm']);
  });
});

test('cleanOut sweeps junk, keeps finals, prunes raw', () => {
  withTempDir((out) => {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'hero.mp4'), 'final');     // a publishable final → keep
    writeFileSync(join(out, 'contact.png'), 'junk');   // regenerable → delete
    const raw = rawDir(out);
    fakeRecording(raw, 'old', 1000);
    fakeRecording(raw, 'new', 2000);

    const { removed } = cleanOut(out, { keep: 1 });
    assert.ok(removed >= 1);
    assert.ok(existsSync(join(out, 'hero.mp4')));
    assert.ok(!existsSync(join(out, 'contact.png')));
    const webms = readdirSync(raw).filter((f) => f.endsWith('.webm'));
    assert.deepEqual(webms, ['new.webm']);
  });
});

test('cleanOut on a non-existent dir is a no-op', () => {
  withTempDir((dir) => {
    assert.deepEqual(cleanOut(join(dir, 'does-not-exist'), {}), { removed: 0 });
  });
});

test('wipeWork removes the work/ intermediates dir', () => {
  withTempDir((out) => {
    const work = workDir(out);
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, 'tmp.mp4'), 'x');
    assert.equal(wipeWork(out), 1);
    assert.ok(!existsSync(work));
  });
});
