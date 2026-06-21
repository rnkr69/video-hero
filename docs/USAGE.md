# Usage guide — demo-recorder

> 🌐 **English** · [Español](GUIA_DE_USO.md)

How to record a **smooth and deterministic** hero/demo video of a web app. Designed for
any platform. The workflow is always the same loop:

> **write script → record → generate contact-sheet → look at it → adjust → encode**

Index:
1. [Requirements (one time)](#1-requirements-one-time)
2. [Quick start with the demo](#2-quick-start-with-the-demo-verifies-your-installation)
3. [The script schema (YAML)](#3-the-script-schema-yaml)
4. [Recording your real web app, step by step](#4-recording-your-real-web-app-step-by-step)
5. [Making the app deterministic (real-app mode)](#5-making-the-app-deterministic-real-app-mode)
6. [Login / session](#6-login--session)
7. [Encode: subtitles, voice, speedup, mp4/gif](#7-encode-subtitles-voice-speedup-mp4gif)
8. [The self-verification loop](#8-the-self-verification-loop-key)
9. [Publishing](#9-publishing)
10. [Common problems](#10-common-problems)
11. [Using it from Claude Code](#11-using-it-from-claude-code)

---

## 1. Requirements (one time)

```bash
cd /path/to/video_hero   # the folder where you cloned this repo
npm install
npm link        # registers the global `demo-recorder` command (to use it from other projects)
# The Chromium browser is already cached. If it fails due to revision mismatch:
npx playwright install chromium
```

- **Node 20+** (you have 24).
- **ffmpeg** installs by itself via `ffmpeg-static` (no system install needed).
- **No API keys required**: voice uses `edge-tts` (free).

> **Per-OS installation.** The native binaries (`ffmpeg-static`, Playwright's Chromium) are
> platform-specific, so `node_modules` **is not portable across operating systems**. If the repo
> lives in a shared folder (e.g. a Windows path used from WSL), install separately in each
> environment: when switching OS run `rm -rf node_modules && npm install` (and `npx playwright
> install chromium`). The CLI detects an install from another OS and shows this same fix before
> running.

> **Two ways to invoke it (equivalent):**
> - **Global CLI** (recommended, works from any folder): `demo-recorder run my.yml`
> - **Local** (inside video_hero): `node src/run.js my.yml`
>
> In this guide you'll see `node src/...`; substitute `demo-recorder ...` if you use the CLI.

### Using it from ANOTHER project (the usual case)

The engine is installed only once (here). From your web app's project — where Claude Code
knows the app — you write the `.yml` and launch it with the global CLI; **the outputs land in
that project**:

```bash
cd /path/to/your-web-project
demo-recorder probe  ./my-demo.yml       # 1) validate selectors/auth (headed, ~10s, no recording)
demo-recorder record ./my-demo.yml       # 2) record without encode -> demo-out/page@<hash>.webm
demo-recorder frames ./demo-out/page@<hash>.webm   #    contact-sheet to review
demo-recorder encode ./my-demo.yml       # 3) voice/subtitles/mp4 once at the end
```

Commands: `demo-recorder probe|record|encode|run|frames|login|mock|help`. There is a **global
skill** (`demo-video-hero`) in all your projects: ask Claude Code to record the
video and it writes the `.yml`, tests it with `probe`, records, looks at the contact-sheet and adjusts.

---

## 2. Quick start with the demo (verifies your installation)

Before your real web app, check that the whole pipeline works with the example app:

```bash
# Terminal 1: backend + demo app
npm run mock
# Terminal 2: record the example script
node src/run.js examples/demo.yml
# -> prints  VIDEO: out/page@<hash>.webm
```

Generate a contact-sheet and look at it:

```bash
node scripts/frames.mjs out/page@<hash>.webm
# opens out/contact.png  (each frame carries its timestamp)
```

If you see cursor, typing, table and zoom → everything is OK. Other examples to test the layers:
`examples/autozoom.yml` (auto-zoom + speedup), `examples/captions.yml` (subtitles),
`examples/narrate.yml` (voice + subtitles).

---

## 3. The script schema (YAML)

A script is a `.yml` with configuration + a list of `steps`. Minimum:

```yaml
url: http://localhost:3000      # your app
width: 1280                     # optional (default 1280)
height: 800                     # optional (default 800)
scale: 2                        # optional, HiDPI sharpness (default 2)
headless: true                  # optional (default true)
out: out                        # optional, output folder

steps:
  - hold: 800                                   # wait ms
  - type: { sel: '#search', text: 'hola', cps: 38 }   # type char-by-char
  - click: '#submit'                            # click with cursor + pulse
  - click: { sel: 'nav a.report', nav: true }   # click that NAVIGATES to another page
  - move: '#kpi'                                # move the cursor to an element
  - waitFor: '.results'                         # wait until it appears (Playwright)
  - zoomFit: '.results'                         # AUTO-ZOOM to the bounding box
  - zoomTo: { sel: '#chart', scale: 1.3 }       # manual zoom (fixed scale)
  - resetZoom: true                             # back to 1x
  - caption: 'On-screen text'                   # subtitle from here…
  - caption: ''                                 #   …empty = remove it
```

**Selectors — important rule (two syntaxes):**
- In `type/click/move/zoomTo/zoomFit` (they go through the injected layer) use `host >>> inner`
  to pierce **shadow DOM** (web components). E.g.: `my-widget >>> textarea`.
- In `waitFor` (it goes through Playwright) use **regular CSS**; Playwright pierces open
  shadow roots automatically. E.g.: `my-widget table`.

### Effect steps (choreography)

On top of the basics there are **in-page effect steps**, drawn live during the recording (so they
show up in the contact-sheet — no encode needed). They use the same `>>>` selector syntax. The
aesthetic rationale for each is in **[docs/AESTHETICS.md](AESTHETICS.md)**.

```yaml
steps:
  # Attention mask (Screen-Studio spotlight): dim everything but the element.
  - spotlight: { sel: '#chart', dim: 0.6 }       # standalone
  - zoomFit:   { sel: '#chart', spotlight: true } # …or coupled to an auto-zoom
  - spotlightOff: true                            # (resetZoom also clears it)

  # On-screen keycaps (shortcuts): 'cmd+k' → ⌘ + K capsules.
  - keycap: 'cmd+k'                               # alias: `key`

  # Callouts / annotations anchored to an element (track it under zoom).
  - annotate: { sel: '#send', shape: arrow, side: left, text: 'Click here', color: '#FFCC00' }
  - annotate: { sel: '#row',  shape: box,    text: 'Result' }   # box | circle | arrow
  - annotateOff: true                             # (resetZoom also clears callouts + highlights)

  # Animated text highlight sweep (marker / underline).
  - highlight: { sel: 'h1', mode: marker, color: 'rgba(255,214,0,.40)' }

  # Smooth eased scroll (instead of a hard jump).
  - scroll: { sel: '#section', ms: 700 }

  # Click variants + attention pop + ripple ring.
  - click: { sel: '#row', variant: double }       # single (default) | double | right
  - click: { sel: '#kpi', ripple: true, pop: true }

  # Cursor personality: a small bounce on arrival + a fading trail.
  - move: { sel: '#cta', overshoot: true, trail: true }

  # Name the current section → rendered as an animated lower-third at encode time.
  - chapter: '1. Ask in natural language'
```

---

## 4. Recording your real web app, step by step

1. **Start your app** on a local URL (or use its deployed URL).
2. **Copy an example** as a starting point:
   ```bash
   cp examples/demo.yml examples/my-demo.yml
   ```
3. **Edit `my-demo.yml`**: set your `url` and rewrite the `steps` with your selectors and the
   flow. (To find selectors: open your app → right-click → Inspect.)
4. **PROBE** (validate selectors/auth in ~10 s, without recording; stops at the first failing
   step and dumps the DOM):
   ```bash
   demo-recorder probe my-demo.yml          # tune ONE beat with  --from N --to M
   ```
5. **RECORD** (record only, fast) + look at the contact-sheet, and **adjust** timing/zoom:
   ```bash
   demo-recorder record my-demo.yml
   demo-recorder frames demo-out/page@<hash>.webm
   ```
   Repeat step 5 until it's smooth (don't encode yet: TTS/subtitles take 30–60 s).
6. **ENCODE** once at the end (voice/subtitles/mp4, section 7):
   ```bash
   demo-recorder encode my-demo.yml
   ```

> If your app always responds **the same way** (static or fixed data) → this is enough.
> If it has dynamic data, an LLM, streaming, current time, etc. → continue in section 5.

---

## 5. Making the app deterministic (real-app mode)

To make the script **repeatable**, pin ONLY what's non-deterministic and leave the rest real,
with `route` rules (they're tested in order, the first match wins):

```yaml
url: https://my-app.com
route:
  # 1) Pin a JSON endpoint to canned data (the most common):
  - url: '**/api/dashboard*'
    json: { data: { kpis: [ ... ], chart: { ... } } }

  # 2) Block noise (analytics, ads, telemetry websockets):
  - url: '**/analytics/**'
    abort: true

  # 3) SSE streaming (LLM chat): route.fulfill does NOT stream (delivers all at once), so
  #    redirect to a local SSE mock that emits with pauses (same protocol; works over http):
  - url: '**/chat/stream'
    redirect: http://127.0.0.1:4317/chat/stream
```

`url` accepts glob (`*`) or substring. Actions per rule: `json`, `body`+`contentType`,
`file`, `redirect`/`mock`, `abort`. Anything that matches no rule goes to the real backend.

> For an LLM chat's SSE, the most reliable approach is to spin up the `mock-server` (adapt it to
> your endpoints, see `examples/mock-server.mjs`) and `redirect` the streaming route to it.

### Apps with chat / streaming (LLM) — universal pattern

- **Raise `waitTimeout: 45000`** at the root of the script: the 20 s default is short for LLMs.
- **Before sending the next message, wait for the send button to be RE-ENABLED**
  (a reliable "finished streaming" signal), not just for text to appear:
  ```yaml
  - waitFor: 'button.send:not([disabled])'
  ```
  Other signals: the streaming cursor disappearing, or the final block appearing.

### Preflight (warns you about the traps)

`probe`/`record`/`run` warn if `url` doesn't match `$APP_URL` (the classic
**127.0.0.1 ↔ localhost** trap that breaks cookies/CSRF in Laravel and similar), or if you end up
on another host / on the login page despite `storageState`. If you see `[preflight]`, use the **same host** as
your app before continuing.

---

## 6. Login / session

If your app requires authentication, log in **once** and reuse the session.

**Option A — from the YAML** (scriptable login). Declare `storageState`; if the file doesn't
exist, the `login.steps` run once and the session is saved and reused:

```bash
export DEMO_EMAIL="you@example.com" DEMO_PASSWORD="secret"
```
```yaml
storageState: auth.json
login:
  url: https://my-app.com/login
  steps:
    - type: { sel: 'input[type=email]', text: '${DEMO_EMAIL}' }
    - type: { sel: 'input[type=password]', text: '${DEMO_PASSWORD}' }
    - click: { sel: 'button[type=submit]', nav: true }
    - waitFor: '.dashboard'
```

**Option B — manual (for MFA/captcha):** edit `scripts/login.mjs` with your URL/selectors
and run it; the browser opens (headed) so you can complete whatever is needed:

```bash
node scripts/login.mjs    # saves auth.json
```

Notes:
- `${VAR}` is substituted from the environment → **never** put passwords in the YAML.
- `auth*.json` is in `.gitignore` (it contains your session: don't commit it).
- To regenerate the session, delete `auth.json` and record again.

Full real-app template with login + route: **`examples/real-app.yml`**.

---

## 7. Encode: subtitles, voice, speedup, mp4/gif

Add an `encode:` block at the end of the script. Everything is optional and applied after recording:

```yaml
encode:
  srt: out/demo.srt              # writes the subtitle file (.srt)
  captionsMp4: out/demo-cc.mp4   # burns the subtitles into an mp4
  narrateMp4: out/demo-voice.mp4 # TTS voice (if captionsMp4 is present, outputs voice + subtitles)
  ttsOpts:
    voice: es-ES-ElviraNeural    # or es-ES-AlvaroNeural, es-MX-DaliaNeural, es-MX-JorgeNeural…
  idleMp4: out/demo-fast.mp4     # speeds up the dead time (the `hold`s)
  idleOpts: { speed: 4 }
  mp4: out/demo.mp4              # plain H.264 mp4
  gif: out/demo.gif              # short highlight gif
```

Keys:
- **Subtitles/voice** are synced to your `caption`s. **Leave enough `hold`** so the
  narration fits; if one overflows, the log warns you with how much to raise that hold
  (the voice is cached in `.cache/tts`, so re-rendering is instant).
- **Don't combine** subtitles/voice with `idleMp4`: the speedup changes the timeline and
  desyncs. Produce the video with voice/subtitles separately from the sped-up one.

### Aesthetic enhancements (subs, intro, music, SFX, reframe, outro…)

All of these are documented in detail in **[docs/AESTHETICS.md](AESTHETICS.md)**:

- **Choosing tracks** — the 4 combinations (video only / +audio / +subs / +both). For
  **audio without subs**, use `narrateMp4` without `captionsMp4` (example `examples/voice-only.yml`).
- **Styled subtitles** — `captionsOpts.style` (object) generates an `.ass`: outline instead of a
  black box, configurable font/color/weight and fade-in/out. Example `examples/styled-subs.yml`.
- **Branded intro** — `encode.intro` prepends a card with logo + title + animation
  (`ffmpeg` or `html` engine); with the `ffmpeg` engine the typography is set with `font`/`fontBold`.
- **Bundled typography** — subtitles, intro and contact-sheet use **Inter** (in `fonts/`) by
  default, so the render is identical on Windows/macOS/Linux without installing fonts. Pass `fontFile`
  (subs) or `font`/`fontBold` (intro) to use your own typeface.
- **Background music with ducking** — `ttsOpts.music` lowers the music before the first TTS, raises
  it during long gaps and returns it at the end. **3 tracks included** (aliases `ambient-gold`,
  `sidewalk-chalk`, `she-said-i-wonder`; `demo-recorder tracks`) or your own audio. Example `examples/intro-music.yml`.
- **Intro templates + match-cut** — `intro.template` (`minimal`/`bold`/`terminal`/`mesh`),
  `intro.typewriter`, and `intro.matchCut` (or `encode.transition`) to dissolve/zoom intro→demo
  instead of a hard cut. Example `examples/match-cut.yml`.
- **Outro end-card** — `encode.outro` (mirror of the intro: animated card with CTA/URL/logo);
  intro+demo+outro share one continuous music bed. Example `examples/outro.yml`.
- **Step-synced SFX** — `encode.sfx` plays short sound effects on the recorded beats (clicks,
  zooms, keycaps) from the `<video>.events.json` sidecar, mixed over the ducked audio. You supply
  the audio in `audio/sfx/`. Example `examples/sfx.yml`.
- **Multi-format reframe** — `encode.reframe: ['9:16','1:1']` exports extra aspect ratios with
  blurred padding (for social) from the same recording. Example `examples/sfx.yml`.
- **Lower-thirds + watermark** — `encode.lowerThirds` turns `chapter:` steps into an animated
  chapter strip; `encode.watermark` adds a corner bug (text or logo). Example `examples/chapters.yml`.

```yaml
encode:
  captionsMp4: out/demo-cc.mp4
  captionsOpts: { style: { outlineColor: '#101010', outline: 2, fadeIn: 200, fadeOut: 200 } }
  narrateMp4: out/demo.mp4
  ttsOpts:
    voice: es-ES-ElviraNeural
    music: { track: ambient-gold, full: 0.85, duck: 0.16, lead: 1.2, gapRaise: 3.0 }  # included track (alias)
  intro: { engine: html, template: mesh, typewriter: true, title: 'My Web App', matchCut: true, result: out/demo-final.mp4 }
  outro: { engine: html, title: 'Try it', cta: 'Get started', url: 'github.com/me/app' }
  lowerThirds: { hold: 3.0 }
  watermark: { text: 'My Brand', pos: br }
  sfx: { gain: 0.8 }              # needs audio in audio/sfx/ (click/whoosh/key/chime)
  reframe: ['9:16', '1:1']
```

---

## 8. The self-verification loop (key)

You don't need to watch the video live. After each recording (`record`):

```bash
demo-recorder frames demo-out/page@<hash>.webm
```

It generates the contact-sheet in `out/frames/` (a grid of frames **with each one's
timestamp**). Open it and check the cursor, typing, content render and zoom framing. If something
fails, you know the exact second → adjust the `hold`/`zoom`/selector and re-record with `record`.

Frames at specific moments:
```bash
demo-recorder frames out/raw/page@<hash>.webm "0.5,3,5,7,9"
```

> For **selector or auth** failures (not timing), use `demo-recorder probe` instead of
> recording: it's headed, stops at the first failure and dumps the DOM. Much faster.

---

## 8.1 The out/ folder (organization and cleanup)

`out/` is kept tidy so the **final video** is easy to find:

```
out/
├── my-demo.mp4         ← FINALS (what you publish) — loose in the root
├── raw/                ← recordings page@<hash>.webm (+ .json). The last 3 are kept
├── frames/             ← review contact-sheets (no loose tiles)
└── work/               ← intermediates (-cc.mp4, intro, .ass, temporaries) — auto-cleaned
```

- After each `run`, the old recordings in `raw/` are **pruned** (the 3 most recent are
  kept, configurable with `keepRaw:` in the script) so you can re-encode without piling up gigs.
- The **intermediates** (subtitles `-cc`, intro clip, `.ass`, temporaries `.novol`/`.mtmp`) go
  to `out/work/` and delete themselves when finished.
- Purge on demand with **`demo-recorder clean`**: it deletes noise (tiles, contact-sheets, `_scratch`,
  intermediates) and prunes `raw/`, **without touching the finals**. `--all` also empties `raw/` and `frames/`;
  `--keep N` changes how many recordings to keep.

```bash
demo-recorder clean              # normal cleanup (keeps finals + 3 recordings)
demo-recorder clean --all        # deep purge (finals only)
demo-recorder clean --keep 1     # keeps only the last recording
```

---

## 9. Publishing

- **GitHub README (the simplest):** drag the `.webm` into the README editor (GitHub
  hosts it and plays it inline; 10 MB limit, ~30 s clips run 2–3 MB). No encoding needed.
- **Maximum compatibility / with voice:** use the `.mp4` (H.264) — e.g. `out/demo-voice.mp4`.
- **Lightweight highlight:** a short `.gif`.

---

## 10. Common problems

| Symptom | Cause | Solution |
|---|---|---|
| Streaming appears "all at once" | `route.fulfill` doesn't stream | SSE mock with pauses + `redirect` (section 5) |
| `⚠ ffmpeg is not installed for this platform` / `No such filter: 'drawtext'` / ffmpeg won't start | `node_modules` installed on another OS (shared Windows/WSL folder) | `rm -rf node_modules && npm install` in this environment |
| `chromium.launch` "Executable doesn't exist" | browser revision out of date | `npx playwright install chromium` |
| Can't find a widget's element | it's in shadow DOM | use `host >>> inner` in type/click/zoom |
| `waitFor` can't find it but the click can (or vice versa) | two selector syntaxes | `waitFor` = Playwright CSS; the rest = `>>>` |
| Blurry video | no HiDPI | `scale: 2` (or more) |
| The zoom crops content | high scale near an edge | use `zoomFit` (auto) or lower `scale` |
| The narration overlaps the next phase | short `hold` | raise that `hold` (the log tells you how much) |
| Empty frames at the end of the contact-sheet | timestamp beyond the clip | the clip is shorter; use valid timestamps |
| The voice stopped generating | edge-tts uses an unofficial MS endpoint | retry; if it persists, use the `openai`/Chatterbox provider |
| `waitFor` times out in an LLM chat | 20 s is too little for streaming | `waitTimeout: 45000` and wait for `button:not([disabled])` |
| `[preflight]` warning 127.0.0.1↔localhost | `url`'s host ≠ your app's | use the SAME host (cookies/CSRF) |
| Hard to find the right selector | you iterate by recording (slow) | `demo-recorder probe` headed: stops at the failure and dumps the DOM |

---

## 11. Using it from Claude Code

There is a **skill** (`demo-video-hero`) that teaches Claude Code to generate and tune scripts
for you. Just ask it something like:

> "I have the app at `http://localhost:3000`. I want a video that opens the panel, searches for X,
> shows the result with zoom and goes to the report. Use demo-recorder."

Claude Code will write the `.yml`, record, generate the contact-sheet, look at it and adjust
until it's smooth — the loop from section 8, automated.
