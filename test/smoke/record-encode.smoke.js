// End-to-end smoke test: mock-app → record (Chromium) → encode (ffmpeg).
// Gated — it launches real binaries, so it only runs with RUN_SMOKE=1 and skips cleanly
// when Chromium or ffmpeg-static aren't available. Run with: npm run test:smoke (RUN_SMOKE=1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const PORT = 4317;

// Skip unless explicitly enabled AND both binaries are present.
function whySkip() {
  if (!process.env.RUN_SMOKE) return 'set RUN_SMOKE=1 to run the end-to-end smoke test';
  if (!ffmpegPath || !existsSync(ffmpegPath)) return 'ffmpeg-static binary not found';
  try { if (!existsSync(chromium.executablePath())) return 'Chromium not installed (npx playwright install chromium)'; }
  catch { return 'Chromium not installed (npx playwright install chromium)'; }
  return null;
}

async function waitForServer(url, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('mock server did not come up at ' + url);
}

test('record + encode against the mock app', { timeout: 180000 }, async (t) => {
  const skip = whySkip();
  if (skip) { t.skip(skip); return; }

  const out = mkdtempSync(join(tmpdir(), 'demorec-smoke-'));
  const server = spawn(process.execPath, [join(REPO, 'examples', 'mock-server.mjs')],
    { stdio: 'ignore', env: { ...process.env, PORT: String(PORT) } });

  t.after(() => {
    try { server.kill(); } catch { /* ignore */ }
    try { rmSync(out, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  await waitForServer(`http://127.0.0.1:${PORT}/`);

  // Tiny spec: caption a beat, hold, clear — enough to drive a webm + caption sidecar + srt.
  const srt = join(out, 'subs.srt');
  const mp4 = join(out, 'demo.mp4');
  const specPath = join(out, 'smoke.yml');
  writeFileSync(specPath, [
    `url: http://127.0.0.1:${PORT}/`,
    'width: 640',
    'height: 400',
    'headless: true',
    `out: ${JSON.stringify(out)}`,
    'steps:',
    '  - caption: Hola mundo',
    '  - hold: 0.6',
    "  - caption: ''",
    'encode:',
    `  srt: ${JSON.stringify(srt)}`,
    `  mp4: ${JSON.stringify(mp4)}`,
  ].join('\n'), 'utf8');

  // Import lazily so a missing browser can't break collection of the other test files.
  const { runScript } = await import('../../src/run.js');
  await runScript(specPath, {});

  // A raw recording landed in out/raw/ with its caption sidecar.
  const rawDir = join(out, 'raw');
  const webms = readdirSync(rawDir).filter((f) => f.endsWith('.webm'));
  assert.ok(webms.length >= 1, 'expected a .webm in out/raw/');
  const captionsSidecar = join(rawDir, `${webms[0]}.captions.json`);
  assert.ok(existsSync(captionsSidecar), 'expected a captions sidecar');
  const caps = JSON.parse(readFileSync(captionsSidecar, 'utf8')).captions;
  assert.equal(caps.length, 2); // 'Hola mundo' + the empty clear

  // Encode outputs exist and are non-empty.
  assert.ok(statSync(mp4).size > 0, 'mp4 should be non-empty');
  const srtText = readFileSync(srt, 'utf8');
  assert.match(srtText, /Hola mundo/);
});
