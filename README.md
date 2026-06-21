# demo-recorder

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/Node-20%2B-43853d.svg?logo=node.js&logoColor=white)](https://nodejs.org/)

Record **deterministic** hero/demo videos of any web app — smooth, repeatable, and fully scripted.

## Demo

> The video below was recorded **by demo-recorder itself** — the landing page in
> [`presentation/`](presentation/) scripted by [`hero.yml`](hero.yml). One continuous take showing
> the effect toolset: a match-cut intro (mesh + typewriter), spotlight, on-screen keycaps, callouts,
> a highlight sweep, karaoke captions, chapter lower-thirds, ducked music, SFX and an outro card. 🎬

https://github.com/user-attachments/assets/fd43a9ea-c4ba-47b0-9689-1df256cf58b1



Recording product demos by hand (OBS and friends) never looks polished: the mouse jitters, timing is
inconsistent, and every take is different. `demo-recorder` solves that with a scripted pipeline:

```
Deterministic source (your app, with optional mocked endpoints)
        │
        ▼
Playwright recordVideo  ── captures REAL pixels (streaming, canvas, shadow DOM, everything)
        │   + an injected layer: animated cursor (easing) · char-by-char typing · click pulse/ripple
        │     · Screen-Studio auto-zoom · spotlight · keycaps · callouts · highlight sweep
        ▼
   .webm  ──(ffmpeg)──▶  .mp4 / .gif (+ 9:16/1:1) + voice · subtitles/karaoke · music · intro/outro
```

You describe the demo once in a small YAML script. The tool plays it back identically every time, so
re-recording after a UI tweak is a one-command operation rather than a fresh manual take.

## Highlights

- **Deterministic** — same script, same video, every run.
- **Real pixels** — Playwright captures whatever the browser renders: video, canvas, web components.
- **Cinematic in-page effects** — synthetic eased cursor, realistic typing, click pulses/ripples,
  Screen-Studio auto-zoom, **spotlight**, on-screen **keycaps**, **callouts**, and a **highlight
  sweep** — all drawn live during the recording.
- **Full post-production** — AI voiceover, clean or **karaoke** subtitles, ducked music, animated
  **intro templates** with **match-cut**, an **outro** card, **lower-thirds**, **watermark**,
  step-synced **SFX**, idle-speedup and **speed ramps**, a subtle **colour grade**, plus mp4/gif —
  all from the same script.
- **Multi-format for social** — export **9:16 / 1:1** cuts (with an action-following **smart-crop**)
  from the same recording.
- **No API keys required** — voice uses free `edge-tts`; ffmpeg ships via `ffmpeg-static`.
- **Drive it from any project** — install once, then record demos of *other* apps from their own
  folders.

See [`docs/AESTHETICS.md`](docs/AESTHETICS.md) for the full effect catalogue and recipes.

## Requirements

- **Node 20+**
- **Cross-platform** (Windows, macOS, Linux). Examples use bash, but the `demo-recorder` commands are
  identical in any shell (zsh, PowerShell). Fonts are bundled (Inter, in `fonts/`), so nothing needs to
  be installed on the host OS and renders are identical across platforms.
- ffmpeg is **not** a system dependency — it's bundled via `ffmpeg-static`.

## Installation

```bash
cd /path/to/video_hero   # the folder where you cloned this repo
npm install
npm link          # registers the global `demo-recorder` command (use it from any project)

# Chromium is usually already cached. If a browser-revision mismatch occurs:
npx playwright install chromium
```

`npm link` is what lets you record demos of **other** projects: the engine (Playwright, ffmpeg,
edge-tts) lives here once, and the global `demo-recorder` command runs from any folder. File-path
arguments in your script resolve against **your current directory**, and outputs land there too.

> **Per-OS install.** The native binaries (`ffmpeg-static`, the Playwright Chromium) are
> platform-specific, so `node_modules` is **not** portable across operating systems. If the repo
> lives on a shared drive (e.g. a Windows path used from WSL), install separately in each
> environment — `rm -rf node_modules && npm install` (plus `npx playwright install chromium`) when
> you switch OS. The CLI detects a cross-OS install and prints this exact fix before running.

## Quick start

Verify your install against the bundled demo app:

```bash
demo-recorder mock                       # terminal 1: starts the example server on 127.0.0.1:4317
demo-recorder run examples/demo.yml      # terminal 2: records + encodes the sample demo
```

The finished video lands in `out/`. Open it, or generate a contact sheet to review it at a glance:

```bash
demo-recorder frames out\<your-video>.webm
```

## How it works — the iteration loop

The workflow is always the same loop, and **encoding is deliberately separate from recording** so
iterating never re-spends time on voice synthesis or ffmpeg:

```
write script → probe → record → frames → look at the contact sheet → adjust → … → encode once
```

1. **`probe`** — dry-run, headed, no recording. Stops at the first failing step and dumps DOM
   diagnostics. The fastest way to fix selectors, `waitFor`s, and auth.
2. **`record`** — record only (no encode). Fast; use it to tune timing and zoom.
3. **`frames`** — build a contact sheet (a tiled grid of frames). One look shows cursor, typing,
   zoom, and timing across the whole clip without watching the video.
4. **`encode`** — run once at the end to add voice, subtitles, music, intro, and export mp4/gif.

## Commands

```
demo-recorder probe  <script.yml> [--from N] [--to M]   dry-run HEADED; stop at first failure + DOM dump
demo-recorder record <script.yml> [--from N] [--to M]   record only (fast iteration)
demo-recorder run    <script.yml> [--no-encode]         record + apply the encode block
demo-recorder encode <script.yml> [webm]                apply ONLY the encode block to an existing webm
demo-recorder frames <video> [t1,t2,..] [out.png]       contact sheet → out/frames/
demo-recorder clean  [--all] [--keep N]                 tidy out/ (prune raw/, wipe intermediates)
demo-recorder tracks                                    list bundled background-music tracks/aliases
demo-recorder login  <script.yml>                       (re)generate the saved login session
demo-recorder mock                                      start the example mock server (127.0.0.1:4317)
demo-recorder help
```

`--from N --to M` run a 1-based inclusive sub-range of steps, so you can iterate on a single beat.

Output layout under `out/`: final videos sit at the root, raw recordings in `out/raw/` (auto-pruned
to the last few), contact sheets in `out/frames/`, and disposable intermediates in `out/work/`
(auto-wiped). Run `demo-recorder clean` any time to tidy up.

## The script (YAML)

A script is a small declarative file. Minimal example:

```yaml
url: http://127.0.0.1:4317/
width: 1280
height: 800
scale: 2          # deviceScaleFactor — 2 = crisp/retina capture
headless: true
out: out

steps:
  - hold: 800
  # `>>>` pierces the open shadow root of the <demo-chat> web component (kit selector syntax)
  - type: { sel: 'demo-chat >>> textarea', text: 'Show me sales by region.', cps: 38 }
  - hold: 300
  - click: 'demo-chat >>> button.send'
  - waitFor: 'demo-chat table'        # waitFor uses Playwright CSS (pierces open shadow DOM itself)
  - hold: 500
  - zoomTo: { sel: 'demo-chat', scale: 1.25 }
  - hold: 1800
  - resetZoom: true
  - click: { sel: 'nav a[href="/dashboard"]', nav: true }   # full-page navigation link
  - waitFor: '#chart'
```

### Step actions

| Step | Purpose |
|------|---------|
| `goto` | Navigate to a URL |
| `hold` | Pause (ms). Recorded as idle so `idle-speedup` can compress it later |
| `move` | Move the cursor to an element (`overshoot`, `trail` for personality) |
| `type` | Type text char-by-char into an input/textarea (`cps` = chars/sec) |
| `click` | Move + pulse + click. `nav: true` waits for navigation; `zoom` auto-frames; `variant: double\|right`, `ripple`, `pop` |
| `zoomTo` | Zoom to a fixed scale centered on an element |
| `zoomFit` | Auto-zoom that frames an element's bounding box (Screen-Studio style); `spotlight: true` dims the rest |
| `resetZoom` | Return the camera to 1× (also clears spotlight/callouts) |
| `spotlight` / `spotlightOff` | Dim everything but one element (attention mask) |
| `keycap` (alias `key`) | Show pressed keys as on-screen capsules (e.g. `cmd+k` → ⌘ + K) |
| `annotate` / `annotateOff` | Callout anchored to an element (`shape: arrow\|box\|circle`, `text`, `side`) |
| `highlight` | Animated marker/underline sweep over an element |
| `scroll` | Smooth eased scroll to an element |
| `chapter` | Name the current section → animated lower-third at encode time |
| `caption` | Set the on-screen caption from now on (drives subtitles **and** voiceover) |
| `waitFor` | Wait for a Playwright selector / function |

> **Selector gotcha — two engines:**
> - `click` / `move` / `type` / `zoomTo` / `zoomFit` use the in-page kit → pierce shadow DOM with the
>   custom `host >>> inner >>> deeper` syntax.
> - `waitFor` uses Playwright CSS, which pierces *open* shadow roots automatically (e.g. `demo-chat table`).
>
> When a selector fails, `demo-recorder probe` walks the `>>>` chain element by element and shows you
> where it gave up.

### Encode block (post-production)

Add an `encode:` block to produce the final assets. Anything you omit is skipped.

```yaml
encode:
  mp4: out/demo.mp4
  gif: out/demo.gif
  srt: out/demo.srt            # subtitle sidecar from your caption: steps
  captionsMp4: out/demo-cc.mp4 # burn subtitles ({ karaoke: true } for word-by-word)
  narrateMp4: out/demo-vo.mp4  # AI voiceover synthesized from caption: steps
  idleMp4: out/demo-fast.mp4   # speed up the held "dead time"
  rampsMp4: out/demo-ramps.mp4 # deliberate speed ramps (slow-mo key beats)
  music: true                  # ducked background-music bed (or { track: ambient-gold, ... })
  sfx: { gain: 0.8 }           # step-synced SFX (bundled click/whoosh/key/chime)
  intro:                       # animated intro card prepended to the demo
    engine: html               # template: minimal|bold|terminal|mesh, typewriter, matchCut, sting
    title: My Product
    subtitle: A quick tour
  outro: { title: Try it, cta: Get started, url: github.com/me/app }
  lowerThirds: true            # chapter: steps → animated lower-thirds
  watermark: { text: My Brand, pos: br }
  transitions: { at: [nav, chapter], transition: zoomin }
  progressBar: { color: '#6C5CE7' }
  grade: { vignette: true }
  reframe: { ratios: ['9:16', '1:1'], follow: true }   # social cuts (smart-crop)
```

Captions come from `caption:` steps in your script: the same text drives both the burned-in
subtitles and the voiceover. Voice synthesis is **cached** under `.cache/tts/` (keyed by content), so
re-rendering is offline, free, and deterministic — generate once. The full effect catalogue — with
recipes and every option — lives in [`docs/AESTHETICS.md`](docs/AESTHETICS.md); one example `.yml`
per feature sits in [`examples/`](examples/).

## Recording a real app

For non-deterministic backends (live data, streaming, random content), pin only the unpredictable
requests with `route` rules in the script; everything else hits the real backend. First match wins:

```yaml
url: ${APP_URL}/dashboard
storageState: auth.json        # start logged in (see Login below)
route:
  - { url: '*/api/feed*', json: { items: [ ... ] } }   # canned JSON
  - { url: '*/api/stream*', mock: 'http://127.0.0.1:9000/sse' }  # local mock for streaming
  - { url: '*/analytics*', abort: true }               # block telemetry/noise
```

Rule actions: `{ json }`, `{ body, contentType, status }`, `{ file, contentType }`,
`{ redirect }` / `{ mock }`, and `{ abort: true }`.

> **Host trap:** `127.0.0.1` and `localhost` are different cookie/CSRF origins (Laravel, etc.). Use
> the **same** host everywhere. The built-in preflight warns when your `url` and `$APP_URL` disagree.

Use `${ENV_VAR}` anywhere in the script to inject URLs, tokens, and credentials from the environment
— keep secrets out of the YAML.

## Login / authenticated demos

Add a `login:` block, then generate a saved session once:

```yaml
storageState: auth.json
login:
  url: ${APP_URL}/login
  headless: false              # headed so you can clear MFA/captcha by hand if needed
  steps:
    - type: { sel: '#email', text: '${DEMO_USER}' }
    - type: { sel: '#password', text: '${DEMO_PASS}' }
    - click: '#submit'
```

```bash
demo-recorder login script.yml   # writes auth.json (cookies + localStorage)
```

Subsequent `record`/`run` start already authenticated. `auth.json` files are git-ignored — never
commit them. If a recording lands on a login screen despite `storageState`, the session expired —
re-run `demo-recorder login`.

## Using it from Claude Code (the skill)

This project ships with a **global Claude Code skill** so you can drive the whole recording loop in
natural language from *any* project — "record a demo video of this app", "add a voiceover", "give it
an intro with a logo", "nicer subtitles with stroke and fades". The skill knows the efficient loop
(`probe → record → frames → adjust → encode once`) and writes/adjusts the `.yml` for you.

The skill ships in this repo at [`skills/demo-video-hero/SKILL.md`](skills/demo-video-hero/SKILL.md).
It is meant to be installed **globally** (in your user skills directory), not per-project, so it's
available in every Claude Code session — copy it to:

```
~/.claude/skills/demo-video-hero/SKILL.md
```

Install it once (run from this repo's root):

```powershell
# Windows (PowerShell)
New-Item -ItemType Directory -Force "$HOME\.claude\skills\demo-video-hero" | Out-Null
Copy-Item skills\demo-video-hero\SKILL.md "$HOME\.claude\skills\demo-video-hero\SKILL.md"
```

```bash
# macOS / Linux
mkdir -p ~/.claude/skills/demo-video-hero
cp skills/demo-video-hero/SKILL.md ~/.claude/skills/demo-video-hero/SKILL.md
```

**How it fits together:** the engine (this project) is installed once as the global `demo-recorder`
CLI via `npm link`; the skill is installed once in `~/.claude/skills/`. From then on, in any
project's Claude Code session, you can ask for a demo video — the agent writes the `.yml` in *that*
project (it knows the app's URLs, selectors, and login) and the global CLI runs the engine. One
install of each serves every project.

> Don't keep a second copy under a project's own `.claude/skills/` — two skills with the same `name`
> collide. If the `demo-recorder` command isn't found in a session, re-run `npm link` in this repo.

## Text-to-speech providers

- **`edge`** (default) — Microsoft Edge neural voices via `@andresaya/edge-tts`. Free, no API key,
  high-quality Spanish (default voice `es-ES-ElviraNeural`). Uses an undocumented MS endpoint, so it
  can occasionally break.
- **`openai`** — any OpenAI-compatible `/v1/audio/speech` endpoint (OpenAI itself, or a local
  offline server such as Chatterbox-TTS). Set `baseUrl` / `apiKey` in `ttsOpts`.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `demo-recorder: command not found` | the CLI isn't linked | run `npm link` in this repo, or call `node <path>/src/run.js` |
| `⚠ ffmpeg no está instalado para esta plataforma` / `No such filter: 'drawtext'` / ffmpeg won't exec | `node_modules` installed under another OS (shared drive across Windows/WSL) | `rm -rf node_modules && npm install` in this environment |
| `chromium.launch` "Executable doesn't exist" | browser revision mismatch | `npx playwright install chromium` |
| Element not found in a widget | it lives in shadow DOM | use `host >>> inner` in `type`/`click`/`zoom` steps |
| `waitFor` can't find it but `click` can (or vice-versa) | two selector engines | `waitFor` = Playwright CSS; the kit steps = `>>>` |
| Hard to pin down the right selector | iterating by re-recording is slow | `demo-recorder probe` — headed, stops at the failure, dumps the DOM |
| Blurry video | no HiDPI capture | set `scale: 2` (or higher) |
| Zoom clips the content | high scale near a page edge | use `zoomFit` (auto-framed) or lower the `scale` |
| `waitFor` times out on an LLM/streaming UI | 20s default is too short | `waitTimeout: 45000` and wait for e.g. `button:not([disabled])` |
| Streaming appears all at once | `route.fulfill` can't stream | mock an SSE server with pauses + a `mock`/`redirect` rule |
| Voiceover stopped generating | edge-tts uses an undocumented MS endpoint | retry; if it persists, switch to the `openai` provider (e.g. local Chatterbox) |
| Narration overruns into the next beat | the `hold` is too short | increase that `hold` — the log tells you by how much. Audio is cached, so re-render is cheap |
| Empty frames at the end of the contact sheet | timestamp is past the clip's end | the clip is shorter than you think; pass valid timestamps |
| Recording lands on a login screen despite `storageState` | the saved session expired | re-run `demo-recorder login <script.yml>` |
| `[preflight]` warns about 127.0.0.1 ↔ localhost | `url` host ≠ your app's host | use the **same** host everywhere (cookies/CSRF) |
| `out/` filling up with recordings/intermediates | iterating piles up webms | `demo-recorder clean` (or `--all` to also empty `raw/`/`frames/`) |

## Project layout

```
bin/demo-recorder.js   CLI entry point (flag parsing + command dispatch)
src/run.js             load a YAML/JSON script → drive the recorder; the encode pipeline
src/recorder.js        Playwright session, Driver (step vocabulary), recordVideo, saveAuth
src/cursor-kit.js      in-page window.__demo: synthetic cursor, typing, click pulse, camera zoom
src/encode.js          all ffmpeg: mp4/gif, idle-speedup, subtitles, intro, music, contact sheets
src/tts.js             cached, pluggable text-to-speech (edge / openai)
src/tracks.js          resolve bundled background-music tracks by name/alias/path
src/layout.js          out/ housekeeping (raw/, frames/, work/, pruning)
examples/              one script per feature + a bundled mock app to record against
docs/                  usage guide, design blueprint, aesthetic options (English + Español)
audio/bg/              bundled background-music tracks
assets/                intro card template + test logo
```

## Documentation

The in-depth guides under `docs/` are available in English (linked below) and Spanish (each page
links to its translation at the top):

- [`docs/USAGE.md`](docs/USAGE.md) — full usage guide: script schema, login, encode options,
  troubleshooting. ([Español](docs/GUIA_DE_USO.md))
- [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md) — design rationale and validated decisions.
  ([Español](docs/DEMO_VIDEO_TOOL_BLUEPRINT.md))
- [`docs/AESTHETICS.md`](docs/AESTHETICS.md) — aesthetic options (intro, styled subtitles, music
  ducking). ([Español](docs/MEJORAS_ESTETICAS.md))

Runnable examples live in `examples/` — one `.yml` per feature (`autozoom`, `captions`, `narrate`,
`intro-music`, `styled-subs`, `voice-only`, `real-app`), all playable against the bundled mock app.

## Credits

The bundled background-music tracks in `audio/bg/` come from
[StreamBeats](https://streambeats.com/) — royalty-free music, free to use.

## License

MIT
