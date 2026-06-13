// scripts/login.mjs — log in to your real app ONCE and save the session to auth.json.
// The demo script then starts authenticated via `storageState: auth.json`.
//
//   $env:DEMO_EMAIL="me@x.com"; $env:DEMO_PASSWORD="secret"   # PowerShell
//   node scripts/login.mjs
//
// Headed by default so you can solve MFA/captcha by hand if the scripted flow can't.
// Adjust the URL and selectors to your app. Never hardcode credentials — use env vars.
import { saveAuth } from '../src/recorder.js';

const URL = process.env.DEMO_URL || 'https://your-app.example.com/login';

await saveAuth(async (d) => {
  await d.type('input[type="email"]', process.env.DEMO_EMAIL || '');
  await d.type('input[type="password"]', process.env.DEMO_PASSWORD || '');
  await d.click('button[type="submit"]', { nav: true });
  // Wait for something that only exists once logged in:
  await d.waitFor('[data-authed], nav .user-menu, .dashboard');
}, { url: URL, out: 'auth.json', headless: false });

console.log('AUTH saved to auth.json');
