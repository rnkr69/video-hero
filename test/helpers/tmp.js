// Throwaway-directory + fake-recording helpers for the filesystem tests (layout.js).
// Everything lives under os.tmpdir() so the repo's own out/ is never touched.
import { mkdtempSync, rmSync, writeFileSync, utimesSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Run `fn(dir)` with a fresh temp dir, always cleaned up afterwards.
export function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'demorec-test-'));
  try { return fn(dir); }
  finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

// Drop a fake recording (webm + the two sidecars) into `dir`, stamped with `mtime`
// (seconds) so the newest-first ordering in pruneRaw/cleanOut is deterministic.
export function fakeRecording(dir, name, mtime = 1000) {
  mkdirSync(dir, { recursive: true });
  const webm = join(dir, `${name}.webm`);
  writeFileSync(webm, 'webm');
  writeFileSync(join(dir, `${name}.webm.idle.json`), '{"idle":[]}');
  writeFileSync(join(dir, `${name}.webm.captions.json`), '{"captions":[]}');
  for (const f of [webm, `${webm}.idle.json`, `${webm}.captions.json`]) utimesSync(f, mtime, mtime);
  return webm;
}
