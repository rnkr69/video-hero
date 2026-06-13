// examples/mock-server.mjs — deterministic backend + static host for the demo app.
// Node http, no frameworks. KEY gotcha: stream SSE with `sleep` between chunks
// (NOT route.fulfill / a single write), so the incremental typing effect is real.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(__dirname, 'demo-app');
const PORT = Number(process.env.PORT) || 4317;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sse = (res, ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);

const MIME = {
  '.html': 'text/html; charset=UTF-8',
  '.js': 'text/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.svg': 'image/svg+xml',
};

async function serveStatic(req, res) {
  // map / -> index.html, /dashboard -> dashboard.html, else the file path.
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/') rel = '/index.html';
  else if (rel === '/dashboard') rel = '/dashboard.html';
  const path = normalize(join(APP_DIR, rel));
  if (!path.startsWith(APP_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
}

http.createServer(async (req, res) => {
  // 1) Streaming chat (SSE) — incremental tokens, then a final table block.
  if (req.method === 'POST' && req.url.startsWith('/chat/stream')) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=UTF-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    const answer = 'Aquí tienes las ventas por región del último trimestre. ' +
      'Europa lidera, seguida de Norteamérica.';
    for (const w of answer.split(' ')) {
      sse(res, 'text', { delta: w + ' ' });
      await sleep(55); // <- incremental streaming; do NOT batch this.
    }
    await sleep(400);
    sse(res, 'block', {
      type: 'table',
      data: {
        columns: ['Región', 'Ventas (€)', 'Δ vs Q3'],
        rows: [
          ['Europa', '1.284.500', '+12%'],
          ['Norteamérica', '1.057.200', '+8%'],
          ['LATAM', '486.900', '+21%'],
          ['APAC', '402.300', '+5%'],
        ],
      },
    });
    sse(res, 'done', {});
    res.end();
    return;
  }

  // 2) Dashboard data (canned JSON).
  if (req.url.startsWith('/api/dashboard')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify({
      data: {
        kpis: [
          { label: 'Ventas totales', value: '3,23 M€' },
          { label: 'Pedidos', value: '18.402' },
          { label: 'Ticket medio', value: '175 €' },
        ],
        chart: {
          labels: ['Europa', 'Norteamérica', 'LATAM', 'APAC'],
          values: [1284500, 1057200, 486900, 402300],
        },
      },
    }));
    return;
  }

  // 3) Everything else: serve the real demo-app bundle (authentic chrome).
  await serveStatic(req, res);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`mock-server listening on http://127.0.0.1:${PORT}`);
});
