// scripts/frames.mjs — build a contact sheet from a recorded clip so Claude Code
// (or you) can review cursor / typing / zoom / timing in one timestamped image.
//
//   node scripts/frames.mjs out/<hash>.webm                 # auto-spread frames
//   node scripts/frames.mjs out/<hash>.webm 0.5,3,5,7,9     # explicit timestamps
//   node scripts/frames.mjs out/<hash>.webm "" out/sheet.png
import { dirname, join } from 'node:path';
import { autoContactSheet } from '../src/encode.js';

const input = process.argv[2];
if (!input) {
  console.error('usage: node scripts/frames.mjs <video> [t1,t2,...] [output.png]');
  process.exit(1);
}
const explicit = process.argv[3];
const output = process.argv[4] || join(dirname(input), 'contact.png');
const times = explicit
  ? explicit.split(',').map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n))
  : undefined;

const r = await autoContactSheet(input, { times, out: output });
console.log('CONTACT SHEET:', r.out, '\nframes @', r.times.join('s, ') + 's');
