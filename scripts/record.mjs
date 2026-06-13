// scripts/record.mjs — example demo flow against the bundled demo-app.
// Run the mock server first:  node examples/mock-server.mjs
import { record } from '../src/recorder.js';

const video = await record(async (d) => {
  await d.hold(800);

  // 'demo-chat >>> textarea' pierces the open shadow root of the web component.
  await d.type('demo-chat >>> textarea', 'Muéstrame las ventas por región.');
  await d.hold(300);
  await d.click('demo-chat >>> button.send');

  // Wait until the streamed answer resolves into a rendered table (inside shadow DOM).
  await d.waitFor(() => {
    const c = document.querySelector('demo-chat');
    return !!(c && c.shadowRoot && c.shadowRoot.querySelector('table'));
  });
  await d.hold(500);

  await d.zoomTo('demo-chat', 1.25);
  await d.hold(1800);
  await d.resetZoom();
  await d.hold(400);

  // Navigate to the dashboard (full-page nav link).
  await d.click('nav a[href="/dashboard"]', { nav: true });
  await d.waitFor('#chart');
  await d.hold(700); // let the canvas finish drawing

  await d.zoomTo('#chart', 1.25);
  await d.hold(1500);
  await d.resetZoom();
  await d.hold(500);
}, { url: 'http://127.0.0.1:4317/', headless: true });

console.log('VIDEO:', video);
