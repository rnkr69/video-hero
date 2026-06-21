// Output layout + housekeeping. Keeps out/ tidy so the FINAL videos are easy to find:
//   out/            ← final videos (what you publish)
//   out/raw/        ← raw recordings: page@<hash>.webm + .idle.json/.captions.json
//   out/frames/     ← contact sheets (review screenshots)
//   out/work/       ← intermediates (-cc.mp4, intro clip, .ass, temps) — safe to wipe
import { existsSync, mkdirSync, readdirSync, statSync, rmSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const sub = (out, name) => join(resolve(out || 'out'), name);
export const rawDir = (out) => sub(out, 'raw');
export const framesDir = (out) => sub(out, 'frames');
export const workDir = (out) => sub(out, 'work');

export function ensureDir(d) { if (!existsSync(d)) mkdirSync(d, { recursive: true }); return d; }

// Webm (+sidecars) in raw/, newest first.
const rawWebms = (out) => {
  const dir = rawDir(out);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.webm'))
    .map((f) => ({ dir, f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
};

const SIDECARS = ['', '.idle.json', '.captions.json'];
const rmQuiet = (p) => { try { if (existsSync(p)) { rmSync(p, { recursive: true, force: true }); return 1; } } catch { /* ignore */ } return 0; };

// Keep only the newest `keep` recordings in raw/; delete older ones (+ their sidecars).
// Called automatically after each run so iterations don't pile up gigabytes of webm.
export function pruneRaw(out, keep = 3) {
  let removed = 0;
  rawWebms(out).slice(keep).forEach((w) => SIDECARS.forEach((s) => { removed += rmQuiet(join(w.dir, w.f + s)); }));
  return removed;
}

// Wipe out/work/ (intermediates). Called after a run/encode finishes — by then everything in
// work/ has already been consumed, so the only things left are disposable.
export function wipeWork(out) { return rmQuiet(workDir(out)); }

// Is this filename clearly disposable noise (not a final you'd publish)?
const isJunk = (name) =>
  /-tile-\d+\.png$/i.test(name) ||          // contact-sheet tiles (should never persist)
  /-check[-.]/i.test(name) ||               // review screenshots
  /^_/.test(name) ||                        // scratch prefix
  /^contact.*\.png$/i.test(name) ||         // contact sheets (regenerable)
  /-cc\.(mp4|mov|webm)$/i.test(name) ||     // burned-captions intermediate
  /\.(novol|mtmp)\.\w+$/i.test(name) ||     // pipeline temps
  /\.ass$/i.test(name) ||                   // subtitle build files
  name === 'tts-smoke.mp3' || name === 'intro-title.txt' || name === 'intro-subtitle.txt';

const sweep = (dir) => {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    try { if (statSync(p).isFile() && isJunk(f)) n += rmQuiet(p); } catch { /* ignore */ }
  }
  return n;
};

// Tidy out/: delete junk (tiles, checks, scratch, temps, .ass, -cc, contact sheets), wipe
// work/, prune raw/ to the newest `keep`, and migrate any legacy root-level page@*.webm into
// raw/. `--all` also empties raw/ and frames/. Final videos at the out/ root are never touched.
export function cleanOut(out = 'out', { all = false, keep = 3 } = {}) {
  const root = resolve(out);
  if (!existsSync(root)) return { removed: 0 };
  let removed = 0;

  removed += sweep(root);
  removed += sweep(framesDir(out));
  removed += rmQuiet(workDir(out));            // wipe intermediates wholesale
  if (all) removed += rmQuiet(framesDir(out));

  // Raw retention: consider both raw/ and legacy root-level page@*.webm together.
  ensureDir(rawDir(out));
  const rootWebms = readdirSync(root).filter((f) => f.endsWith('.webm'))
    .map((f) => ({ dir: root, f, t: statSync(join(root, f)).mtimeMs }));
  const all_ = [...rootWebms, ...rawWebms(out)].sort((a, b) => b.t - a.t);
  const keepN = all ? 0 : keep;
  all_.forEach((w, i) => {
    if (i < keepN) {
      if (w.dir === root) SIDECARS.forEach((s) => { // migrate kept legacy recordings into raw/
        const src = join(root, w.f + s);
        if (existsSync(src)) try { renameSync(src, join(rawDir(out), w.f + s)); } catch { /* ignore */ }
      });
    } else SIDECARS.forEach((s) => { removed += rmQuiet(join(w.dir, w.f + s)); });
  });
  return { removed };
}

// Pure predicate exposed ONLY for unit tests (not part of the public API).
export const __test = { isJunk };
