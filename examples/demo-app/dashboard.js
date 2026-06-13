// Fetches canned dashboard data and draws a bar chart on a <canvas>.
// Canvas is used on purpose: recordVideo captures real pixels, so the recorder
// must be able to zoom into a canvas the same as any DOM element.
const res = await fetch('/api/dashboard');
const { kpis, chart } = (await res.json()).data;

// KPIs
document.getElementById('kpis').innerHTML = kpis
  .map((k) => `<div class="kpi"><div class="label">${k.label}</div><div class="value">${k.value}</div></div>`)
  .join('');

// Bar chart (vanilla canvas, no libs).
const canvas = document.getElementById('chart');
const ctx = canvas.getContext('2d');
const W = canvas.width, H = canvas.height;
const pad = { l: 70, r: 30, t: 30, b: 60 };
const plotW = W - pad.l - pad.r;
const plotH = H - pad.t - pad.b;
const max = Math.max(...chart.values) * 1.15;

ctx.clearRect(0, 0, W, H);
ctx.font = '24px system-ui, sans-serif';
ctx.textBaseline = 'middle';

// gridlines + y labels
ctx.strokeStyle = '#ffffff14';
ctx.fillStyle = '#9aa0b4';
ctx.lineWidth = 1;
const ticks = 4;
for (let i = 0; i <= ticks; i++) {
  const v = (max / ticks) * i;
  const y = pad.t + plotH - (v / max) * plotH;
  ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
  ctx.textAlign = 'right';
  ctx.fillText(Math.round(v).toLocaleString(), pad.l - 12, y);
}

// bars
const n = chart.labels.length;
const gap = 28;
const bw = (plotW - gap * (n - 1)) / n;
for (let i = 0; i < n; i++) {
  const x = pad.l + i * (bw + gap);
  const h = (chart.values[i] / max) * plotH;
  const y = pad.t + plotH - h;
  const grad = ctx.createLinearGradient(0, y, 0, y + h);
  grad.addColorStop(0, '#6c5ce7');
  grad.addColorStop(1, '#00cec9');
  ctx.fillStyle = grad;
  const r = 10;
  ctx.beginPath();
  ctx.moveTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.arcTo(x + bw, y, x + bw, y + r, r);
  ctx.lineTo(x + bw, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#e8e9f0';
  ctx.textAlign = 'center';
  ctx.fillText(chart.labels[i], x + bw / 2, pad.t + plotH + 28);
}
