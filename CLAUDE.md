# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`demo-recorder` (the `video_hero` project) records **deterministic** hero/demo videos of any web
app. Pipeline: Playwright `recordVideo` captures real pixels (streaming, canvas, shadow DOM) while
an injected layer draws a synthetic cursor, char-by-char typing, click pulses and camera zoom; then
ffmpeg turns the `.webm` into mp4/gif and lays on voice, subtitles and music.

**Crucially, this project is meant to be driven from OTHER projects.** It installs once (`npm link`)
and exposes the global `demo-recorder` CLI; each consuming project writes its own `.yml` (it knows
its own web app) and the engine here executes it. File-path args in a `.yml` resolve against the
**caller's** cwd; outputs land there too. Docs and code are in Spanish — match that when editing.

## Commands

```powershell
npm install ; npm link          # one-time: register the global `demo-recorder` command
npx playwright install chromium # only if the cached browser revision mismatches

# The CLI (run from any project; paths are relative to your cwd):
demo-recorder probe <guion.yml> [--from N] [--to M]   # dry-run HEADED, no recording; stops at the
                                                      #   first failing step and dumps DOM diagnostics
demo-recorder record <guion.yml> [--from N] [--to M]  # record only (fast iteration; = run --no-encode)
demo-recorder run <guion.yml> [--no-encode]           # record + apply the encode block
demo-recorder encode <guion.yml> [webm]               # apply ONLY the encode block to an existing webm
demo-recorder frames <video> [t1,t2,..] [out.png]     # contact sheet → out/frames/
demo-recorder clean [--all] [--keep N]                # tidy out/ (prune raw/, wipe intermediates)
demo-recorder tracks                                  # list bundled background-music aliases
demo-recorder login <guion.yml>                       # (re)generate the storageState session
demo-recorder mock                                    # start the example mock server (127.0.0.1:4317)

# Equivalent local entry points (inside this repo):
node src/run.js examples/demo.yml      # npm run record:yaml
node examples/mock-server.mjs          # npm run mock
```

There is **no test suite, linter, or build step.** Verification is the loop below, not unit tests.

## The iteration loop (this is the workflow)

`probe` → `record` → `frames` → look at the contact sheet → adjust the `.yml` → repeat → `encode` once.

`encode` is deliberately **decoupled from `record`** so iterating on timing/selectors never re-spends
TTS or re-runs ffmpeg. The intended sequence: `probe` fixes selectors/auth, `record` tunes
timing/zoom, and `encode` (voice/subs/music/mp4) runs once at the end. The contact sheet is the
self-verification mechanism — one `Read` of the tiled PNG shows cursor/typing/zoom/timing across the
whole clip without watching video.

## Architecture

The `.yml` (or `.json`) **spec** is a thin declarative layer; `src/run.js` maps each step to a
`Driver` call and adds no recording logic of its own. Flow of a spec through the code:

- **`src/run.js`** — loads the spec, substitutes `${ENV_VAR}` in every string (keep secrets in env,
  not YAML), runs `preflight`/`postNav` host-mismatch checks, slices `--from/--to` step ranges, and
  dispatches `runScript` / `encodeOnly` / `probeScript` / `runLogin`. `applyEncode` is the whole
  post-production pipeline (srt → burn subs → narrate → idle-speedup → mp4/gif → prepend intro →
  lay one continuous music bed over intro+demo).
- **`src/recorder.js`** — `openSession` builds the Playwright context (viewport, `deviceScaleFactor`,
  `storageState`, route mocks) and injects the cursor kit; `record` wraps it with `recordVideo` and,
  on close, writes timeline **sidecars** next to the webm: `<video>.idle.json` (hold spans, for
  idle-speedup) and `<video>.captions.json` (caption events, for subs + voice). `saveAuth` persists
  a logged-in session. The `Driver` class is the step vocabulary (goto/hold/move/type/click/zoomTo/
  zoomFit/resetZoom/caption/waitFor).
- **`src/cursor-kit.js`** — injected into every navigation via `addInitScript`; defines
  `window.__demo` (synthetic cursor, click pulse, char typing, CSS-transform camera zoom, and the
  Screen-Studio-style `frameTo` auto-zoom). Runs **in the browser** — keep it self-contained.
- **`src/encode.js`** — all ffmpeg (via `ffmpeg-static`): mp4/gif, `speedupIdle` (piecewise setpts
  from the idle sidecar), `contactSheet`, intro card (`buildIntroFfmpeg`), `concatVideos`, music bed
  (`addMusicBed`/`mixVoiceAndMusic` with a keyframe duck envelope), and SRT/ASS subtitle generation.
- **`src/tts.js`** — pluggable, cached TTS. Providers: `edge` (default, free, no key, undocumented
  MS endpoint — can break) and `openai` (any OpenAI-compatible `/v1/audio/speech`, e.g. local
  Chatterbox). Every synthesis is hashed and cached under `.cache/tts/` (outside `out/` on purpose,
  so cleaning `out/` between renders keeps re-renders offline/free). `musicEnvelope` builds the
  ducking keyframes from the narration timeline.
- **`src/tracks.js`** — resolves `music.track` (a path, a bundled filename in `audio/bg/`, or a
  fuzzy alias/slug) to an absolute path; the engine ships its own music so `music` works from any
  project without copying files.
- **`src/layout.js`** — `out/` housekeeping: `out/` = final videos, `out/raw/` = recordings +
  sidecars (auto-pruned to the last few), `out/frames/` = contact sheets, `out/work/` =
  intermediates (auto-wiped after each run/encode).

## Selector gotcha (the recurring trap)

Two different selector engines, depending on the step:

- `click` / `move` / `type` / `zoomTo` / `zoomFit` go through the **in-page kit** → use the custom
  `host >>> inner >>> deeper` syntax to pierce shadow DOM manually.
- `waitFor` goes through **Playwright** → use Playwright CSS, which pierces *open* shadow roots
  automatically (e.g. `demo-chat table`).

When a selector fails, `demo-recorder probe` is the fast diagnosis: it walks the `>>>` chain element
by element and lists the children/visible interactive elements where it gave up.

## Determinism (real-app mode)

Non-deterministic backends are pinned with `route` rules in the spec (first match wins): `{json}`,
`{body}`, `{file}`, `{redirect}`/`{mock}` (e.g. to a local SSE server for streaming endpoints
`route.fulfill` can't stream), or `{abort:true}`. Everything unmatched hits the real backend.

Host trap to watch for: `127.0.0.1` vs `localhost` are different cookie/CSRF origins (Laravel etc.).
`preflight` warns when `spec.url` and `$APP_URL` disagree — use the **same** host throughout.

## References

- `docs/GUIA_DE_USO.md` — full usage guide (the spec schema, login, encode options, troubleshooting).
- `docs/DEMO_VIDEO_TOOL_BLUEPRINT.md` — design rationale and validated decisions.
- `docs/MEJORAS_ESTETICAS.md` — aesthetic options (intro, styled subtitles, music ducking).
- `examples/*.yml` — one spec per feature (autozoom, captions, narrate, intro-music, styled-subs…),
  runnable against the bundled mock app in `examples/demo-app/`.
