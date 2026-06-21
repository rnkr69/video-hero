#!/usr/bin/env node
// demo-recorder CLI — drive the recorder from ANY project (install once with `npm link`).
// File args are resolved against YOUR current directory; the engine + node_modules live
// in the demo-recorder install, so a single install serves every project.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import { runScript, runLogin, encodeOnly, probeScript } from '../src/run.js';
import { autoContactSheet } from '../src/encode.js';
import { cleanOut, framesDir, ensureDir } from '../src/layout.js';
import { bundledTracks } from '../src/tracks.js';
import { warnIfMisinstalled } from '../src/doctor.js';

const PKG = dirname(dirname(fileURLToPath(import.meta.url))); // demo-recorder install root
const argv = process.argv.slice(2);
const cmd = argv[0];

// Tiny flag parser: pulls --no-encode / --from N / --to M; returns { positionals, flags }.
function parse(args) {
  const positionals = [], flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--no-encode') flags.noEncode = true;
    else if (a === '--from') flags.from = Number(args[++i]);
    else if (a === '--to') flags.to = Number(args[++i]);
    else if (a.startsWith('--from=')) flags.from = Number(a.slice(7));
    else if (a.startsWith('--to=')) flags.to = Number(a.slice(5));
    else if (a === '--all') flags.all = true;
    else if (a === '--keep') flags.keep = Number(args[++i]);
    else if (a.startsWith('--keep=')) flags.keep = Number(a.slice(7));
    else positionals.push(a);
  }
  return { positionals, flags };
}

const HELP = `demo-recorder <comando>

  run <guion.yml> [--no-encode] [--from N] [--to M]   graba (+ encode del YAML salvo --no-encode)
  record <guion.yml> [--from N] [--to M]              solo grabar (rápido para iterar; = run --no-encode)
  encode <guion.yml> [webm]                           aplica solo el bloque encode (usa el último webm si no das uno)
  probe <guion.yml> [--from N] [--to M]               dry-run HEADED: ejecuta los pasos sin grabar, para en el 1º que falla y vuelca el DOM
  frames <video> [t1,t2,..] [out.png]                 contact-sheet con timestamps (→ out/frames/)
  clean [--all] [--keep N]                            ordena out/: borra intermedios/temporales y poda raw/ (deja finales)
  tracks                                              lista la música de fondo incluida (audio/bg/) y sus alias
  login <guion.yml>                                   (re)genera la sesión storageState del bloque login
  mock                                                arranca el mock-server de ejemplo (127.0.0.1:4317)
  help

Carpeta out/:  finales sueltos en out/  ·  grabaciones en out/raw/ (últimas 3)  ·  contact-sheets en out/frames/
               ·  intermedios en out/work/ (se autolimpian).  Purga a demanda:  demo-recorder clean [--all]

Bucle eficiente: 1) demo-recorder probe  → arregla selectores/auth   2) demo-recorder record → afina timing/zoom
                 3) demo-recorder encode → voz/subtítulos/mp4 una sola vez al final.

Las rutas son relativas a tu carpeta actual. Ej:  demo-recorder probe .\\mi-demo.yml --from 4`;

async function main() {
  const { positionals, flags } = parse(argv.slice(1));
  // Surface a cross-OS node_modules early (the recurring WSL/Windows trap) for the commands that
  // actually drive the native binaries. Purely informational commands don't need them.
  if (!['help', 'tracks', 'clean', undefined, '--help', '-h'].includes(cmd)) warnIfMisinstalled();
  switch (cmd) {
    case 'run': {
      if (!positionals[0]) throw new Error('falta <guion.yml>');
      await runScript(resolve(positionals[0]), { encode: !flags.noEncode, from: flags.from, to: flags.to });
      break;
    }
    case 'record': {
      if (!positionals[0]) throw new Error('falta <guion.yml>');
      await runScript(resolve(positionals[0]), { encode: false, from: flags.from, to: flags.to });
      break;
    }
    case 'encode': {
      if (!positionals[0]) throw new Error('falta <guion.yml>');
      await encodeOnly(resolve(positionals[0]), positionals[1] ? resolve(positionals[1]) : undefined);
      break;
    }
    case 'probe': {
      if (!positionals[0]) throw new Error('falta <guion.yml>');
      const ok = await probeScript(resolve(positionals[0]), { from: flags.from, to: flags.to });
      if (!ok) process.exit(2);
      break;
    }
    case 'frames': {
      if (!positionals[0]) throw new Error('falta <video>');
      const times = positionals[1]
        ? positionals[1].split(',').map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n)) : undefined;
      // Contact sheets go to out/frames/, named after the video (tiles are auto-deleted).
      const base = basename(positionals[0]).replace(/\.\w+$/, '');
      const out = positionals[2] ? resolve(positionals[2]) : join(ensureDir(framesDir('out')), `contact-${base}.png`);
      const r = await autoContactSheet(resolve(positionals[0]), { times, out });
      console.log('CONTACT SHEET:', r.out, '\nframes @', r.times.join('s, ') + 's');
      break;
    }
    case 'clean': {
      const keep = flags.keep ?? 3;
      const r = cleanOut('out', { all: flags.all, keep });
      console.log(`CLEAN: out/ ordenada — ${r.removed} elemento(s) eliminado(s). ` +
        `raw/ conserva ${flags.all ? 0 : keep} grabación(es); finales intactos.`);
      break;
    }
    case 'tracks': {
      const t = bundledTracks();
      if (!t.length) { console.log('No hay pistas bundled en audio/bg/.'); break; }
      console.log('Música de fondo incluida (usa el alias o el nombre en music.track):');
      for (const { file, slug } of t) console.log(`  ${slug.padEnd(16)} → ${file}`);
      console.log('También puedes pasar la ruta a tu propio audio. Por defecto: la pista "ambient".');
      break;
    }
    case 'login': {
      if (!positionals[0]) throw new Error('falta <guion.yml>');
      console.log('AUTH:', await runLogin(resolve(positionals[0])));
      break;
    }
    case 'mock': {
      spawn(process.execPath, [join(PKG, 'examples', 'mock-server.mjs')], { stdio: 'inherit' });
      break;
    }
    case 'help': case undefined: case '--help': case '-h':
      console.log(HELP); break;
    default:
      console.error(`comando desconocido: ${cmd}\n`); console.log(HELP); process.exit(1);
  }
}

// Pure flag parser + help text exposed ONLY for unit tests (not part of the public API).
export const __test = { parse, HELP };

// CLI guard: only run when invoked directly (not when imported by a test).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('demo-recorder:', e.message); process.exit(1); });
}
