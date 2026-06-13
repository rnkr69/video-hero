// Background-music tracks bundled WITH the engine (audio/bg/), so `music` works from any
// project without copying files. A `music.track` can be: an existing path (relative to the
// current project or absolute), a bundled filename, or a short alias/substring of one.
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE = dirname(dirname(fileURLToPath(import.meta.url))); // install root (src/..)
export const bgDir = () => join(ENGINE, 'audio', 'bg');

const isAudio = (f) => /\.(wav|mp3|m4a|aac|ogg|flac)$/i.test(f);
// Slug for matching: drop the extension and any leading track number ("4. Ambient Gold" →
// "ambient-gold"), then kebab-case.
const slug = (s) => String(s).toLowerCase().replace(/\.[^.]+$/, '')
  .replace(/^\s*\d+\s*[.\-_)]*\s*/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Bundled tracks as { file, slug } (e.g. { file: '4.-Ambient-Gold.mp3', slug: 'ambient-gold' }).
export function bundledTracks() {
  try { return readdirSync(bgDir()).filter(isAudio).map((file) => ({ file, slug: slug(file) })); }
  catch { return []; }
}

// The default bed when `music` is enabled without a track: prefer an "ambient" one (calm, good
// under narration), else the first bundled track.
export function defaultTrack() {
  const t = bundledTracks();
  if (!t.length) return null;
  return join(bgDir(), (t.find((x) => x.slug.includes('ambient')) || t[0]).file);
}

// Resolve a `music.track` value to an absolute path. Throws (listing the bundled options) if a
// given track can't be found; returns the default bundled track if `track` is empty.
export function resolveTrack(track) {
  if (!track) {
    const d = defaultTrack();
    if (!d) throw new Error('no hay pista de música disponible (audio/bg/ del motor está vacío)');
    return d;
  }
  const direct = resolve(track);
  if (existsSync(direct)) return direct;                    // a real path in the current project
  const bundled = bundledTracks();
  const want = slug(track);
  const hit = bundled.find((b) => b.file === track)        // exact bundled filename
    || bundled.find((b) => b.slug === want)                // exact alias
    || bundled.find((b) => b.slug.includes(want) || want.includes(b.slug)); // fuzzy/substring
  if (hit) return join(bgDir(), hit.file);
  throw new Error(`pista de música no encontrada: "${track}". ` +
    `Bundled: ${bundled.map((b) => b.slug).join(', ') || '(ninguna)'} — o pasa una ruta a tu propio audio.`);
}
