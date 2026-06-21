# Aesthetic options in demo-recorder

> 🌐 **English** · [Español](MEJORAS_ESTETICAS.md)

Guide to the aesthetic options. The first four (**track selection**, **styled subtitles**,
**brand intro card**, **background music with ducking**) are configured from the `encode:` block.
The rest are **in-page choreography effects** (drawn live during recording, §5) and more
**post-production** effects (SFX, reframe, outro, lower-thirds, watermark, intro templates &
match-cut; §6–§11). For context and design decisions, see also the plan in `~/.claude/plans/`.

Ready-to-run examples:

| Example | What it shows |
|---------|-------------|
| `examples/voice-only.yml`  | Video + audio **without** subtitles |
| `examples/styled-subs.yml` | "Clean stroke" subtitles (no box) + fades |
| `examples/intro-music.yml` | Intro + voice + subs + music with ducking |
| `examples/effects.yml`     | Spotlight, keycaps, smooth scroll, click variants |
| `examples/annotate.yml`    | Callouts (arrow/box/circle) + highlight sweep |
| `examples/sfx.yml`         | Step-synced SFX + reframe (9:16, 1:1) |
| `examples/chapters.yml`    | Lower-thirds (chapter titles) + watermark |
| `examples/outro.yml`       | Intro + demo + outro with one continuous music bed |
| `examples/match-cut.yml`   | Animated intro template + match-cut into the demo |
| `examples/ramps.yml`       | Deliberate speed ramps (slow-mo key beats, brisk elsewhere) |
| `examples/transitions.yml` | Stylized transitions between sections (nav/chapter) |
| `examples/karaoke.yml`     | Word-by-word karaoke captions synced to the TTS |
| `examples/social.yml`      | Smart-crop 9:16 (follows the action) + progress bar + grade |

```bash
node examples/mock-server.mjs           # deterministic backend (127.0.0.1:4317)
demo-recorder run examples/intro-music.yml
demo-recorder frames out/intro-demo-intro.mp4   # contact sheet for review
```

---

## 1. Choosing tracks (the 4 combinations)

There is no new key: you combine the `encode` keys. The `caption:` steps always record their
timings; whether they are **heard** (voice) or **seen** (subs) depends on which keys you enable.

| Mode | `encode` keys | Notes |
|------|-----------------|-------|
| **Video only** | `mp4` (or `idleMp4`) | No audio or subs |
| **Video + audio** | `narrateMp4` + `ttsOpts` | Without `captionsMp4`: voice comes from the `caption:` steps but is not burned in. Recipe: `voice-only.yml` |
| **Video + subs** | `captionsMp4` + `captionsOpts` | Burned-in subtitles, no voice. Recipe: `styled-subs.yml` |
| **Video + audio + subs** | `captionsMp4` + `narrateMp4` | `narrateMp4` narrates over the already-subtitled video |

Key point: `narrateVideo` uses `captionsMp4` as its base if present, otherwise the clean video —
that is why "audio without subs" works with nothing extra.

---

## 2. Styled subtitles (no black box)

`captionsOpts.style` controls the appearance. If it is an **object** → an `.ass` is generated and
burned with libass (stroke, fades, easing). If it is a **string** → legacy `force_style` mode over
SRT (backwards-compatible). By default (no `style`): **"clean stroke"**.

```yaml
encode:
  captionsMp4: out/demo.mp4
  captionsOpts:
    style:
      font: Inter             # bundled font by default (cross-platform, nothing to install)
      # font: MyFont          # + fontFile to use your own typeface (its family name)
      # fontFile: ./assets/MyFont.ttf   # path to your .ttf; loaded via fontsdir (nothing to install)
      fontSize: 24            # px against an 800-tall reference (scales with the video)
      color: '#FFFFFF'        # text color
      outlineColor: '#101010' # STROKE/border color
      outline: 2              # stroke thickness (px)
      shadow: 0.5             # soft shadow (0 = no shadow)
      bold: false
      alignment: 2            # ASS numpad: 2 = bottom-center, 8 = top-center
      marginV: 48             # vertical margin
      fadeIn: 200             # ms fade-in
      fadeOut: 200            # ms fade-out
      slideUp: 0              # optional: px of entry slide (ease)
```

Notes:
- **No background:** `BorderStyle=1` (stroke + shadow) is used, not the opaque box `BorderStyle=3`.
- **Fades:** each cue carries `{\fad(fadeIn,fadeOut)}`. With `slideUp>0` a `\move` is added
  for a rising entry (an easing approximation with libass).
- **Consistent size:** `fontSize`/margins are authored against an 800 px tall reference; libass
  scales them to the real size (with `scale: 2` the video is 2× and so are the subs).
- **Default font:** **Inter** (bundled in `fonts/`), so the render is identical on
  Windows/macOS/Linux without relying on system fonts. Inter (regular + bold) is always loaded
  via `fontsdir`, nothing to install.
- **Your own font:** set `fontFile` (path to your `.ttf`); it is copied next to the `.ass` and
  loaded via `fontsdir` (avoids escaping the drive `:` on Windows). The `font:` must match the
  font's family name.

---

## 3. Brand intro card (logo + title + animation)

`encode.intro` prepends an intro to the final mp4. Two engines:

```yaml
encode:
  narrateMp4: out/demo.mp4
  intro:
    engine: ffmpeg          # ffmpeg (composited card) | html (recorded template)
    prependTo: out/demo.mp4 # mp4 to prepend to (default: the last one produced)
    result: out/demo-intro.mp4
    duration: 2.8
    logo: assets/logo.png   # PNG with transparency (optional)
    title: 'My Web App'
    subtitle: 'your tagline'  # optional
    bg: '#0B0F1A'           # background color
    fg: '#FFFFFF'           # text color (html engine only)
    animation: fade-zoom    # fade | fade-zoom
    # font: Inter           # (ffmpeg engine only) font; defaults to bundled Inter
    # fontBold: ./assets/MyFont-Bold.ttf   # optional: bold variant for the title
    music: audio/bg/4.-Ambient-Gold.mp3   # optional: music in the intro only
```

- **`engine: ffmpeg`** (default): composites background + logo + title + subtitle with **libass**,
  fade-in/out and a subtle zoom. Deterministic and fast, no browser. Built at the exact size of
  the target video. The typeface is bundled **Inter** (cross-platform); override it with
  `font` (subtitle/regular) and `fontBold` (title) — a path, a bundled name, or an alias (each font
  is copied next to the `.ass` before rendering, so they can live in any path).
- **`engine: html`**: renders `assets/intro.html` (richer CSS animations) and records it with
  the same Playwright engine. Customize that template for your brand.
- The concatenation re-encodes (robust across different encoders) and keeps audio only if
  **all** parts have it (a subs-only or video-only output has no audio → muted but consistent
  result).

---

## 4. Background music with ducking

A music bed under the voice, with an envelope computed from the real timings of each TTS. It is
applied as a **continuous final layer** over the whole video: if there is an intro, the music
**starts with the intro** (at high volume) and continues seamlessly into the demo. It is
configured in `ttsOpts.music` (or `encode.music`).

**Bundled tracks (works from any project).** The engine ships 3 freely-licensed tracks in its
`audio/bg/`; you don't need to copy them into your project. In `track` put an **alias**
(`ambient-gold`, `sidewalk-chalk`, `she-said-i-wonder`), the filename, or a **path** to your
own audio. If you omit `track` it uses the default *ambient*; `music: true` = default +
default ducking. List the aliases with `demo-recorder tracks`.

```yaml
encode:
  narrateMp4: out/demo.mp4
  ttsOpts:
    voice: es-ES-ElviraNeural
    music:
      track: ambient-gold   # bundled alias · or sidewalk-chalk / she-said-i-wonder · or your own path
      full: 0.85       # high volume (long gaps, before and after)
      duck: 0.16       # low volume (during the voice)
      lead: 1.2        # s: ducks BEFORE each TTS (anticipatory dip)
      tail: 0.8        # s: time to rise back up after each TTS
      gapRaise: 3.0    # s: minimum gap between TTS to return to 'full'
      ramp: 0.4        # s: duration of each rise/fall ramp
      fadeIn: 1.0      # s: fade-in at the start
      fadeOut: 1.5     # s: fade-out at the end
```

Envelope behavior:

```
vol │█████▁▁▁▁▁█████▁▁▁▁▁████████
    └──────────────────────────► t
    full   duck   full   duck   full
    (fadeIn) (voice) (gap≥gapRaise) (voice) (end, fadeOut)
```

- The music starts at `full` (with `fadeIn`) and **ducks before** the first TTS thanks to `lead`.
- Two TTS separated by **less** than `gapRaise` keep the duck (the music does not rise in short
  gaps); with a gap ≥ `gapRaise` it rises to `full`.
- After the last TTS it returns to `full`, with `fadeOut` at the end of the video.
- **With an intro:** the voice timings are shifted by the intro's duration, so the bed covers
  `intro + demo` continuously (the intro plays at `full`, with no restart at the cut).
- **Music only (no captions):** if you define `music` but there are no `caption:` steps, you get
  a flat music bed at `full` with fades.

The track loops to cover the whole video, so it does not need to be as long as the clip.

---

## 5. In-page attention effects (live during recording)

These are **steps**, not `encode` keys — they are drawn by the injected layer while recording, so
they appear in the contact-sheet with no encode pass. They render on a screen-space overlay that is
counter-transformed against the camera zoom, so they **track the element correctly even mid-zoom**.
Schema reference for every step is in [USAGE.md §3](USAGE.md#3-the-script-schema-yaml); example
recipes: `examples/effects.yml` and `examples/annotate.yml`.

- **Spotlight / attention mask** — dim everything but one element (the Screen-Studio look). Use it
  standalone (`spotlight: { sel, dim }`) or coupled to an auto-zoom (`zoomFit: { sel, spotlight: true }`).
  `spotlightOff` clears it; `resetZoom` clears it automatically. Best on the one thing the viewer
  must look at — a result, a button, a KPI.
- **Keycaps** — show pressed shortcuts as capsules (`keycap: 'cmd+k'` → ⌘ + K), glyph-mapped
  (`cmd`→⌘, `enter`→⏎, `shift`→⇧…). Essential for shortcut-driven apps. Note: typing dispatches
  input events, not real keystrokes, so keycaps are **declared**, not captured — add them where you
  want the key shown.
- **Callouts / annotations** — `annotate: { sel, shape, text, side, color }` draws an arrow / box /
  circle anchored to an element, with an optional label. Turns a demo into a near-tutorial.
  `annotateOff` (and `resetZoom`) clear them.
- **Highlight sweep** — `highlight: { sel, mode }` wipes an animated marker (`marker`, multiply
  blend) or `underline` across a phrase or value.
- **Cursor & click polish** — `move: { overshoot, trail }` gives the cursor a small arrival bounce
  and a fading trail; `scroll: { sel, ms }` eases the page (a hard scroll jump is the usual tell
  that a demo is scripted); `click` gains `variant: single|double|right`, a `ripple` ring and a
  `pop` (the element scales briefly on interaction).

---

## 6. Step-synced SFX (`encode.sfx`)

Short one-shot sound effects placed on the **recorded beats** — clicks, zooms, keycaps — and mixed
**on top of** the (already ducked) music. The recorder writes a `<video>.events.json` sidecar with a
timestamp for every visual beat; the SFX stage maps each `kind` to a sound and lays them in with
`adelay`+`amix` (`normalize=0`, so the bed level is preserved). When an intro is prepended, the
event times are shifted by the intro's length so the SFX stay in sync. Example: `examples/sfx.yml`.

```yaml
encode:
  narrateMp4: out/demo.mp4
  ttsOpts: { voice: es-ES-ElviraNeural, music: { track: ambient-gold } }
  sfx:
    gain: 0.8                 # global gain (0..1+)
    # dir: assets/sfx         # optional: your own SFX folder
    map:                      # override the kind → sound map (null mutes a kind)
      click: click
      zoom: { name: whoosh, gain: 0.5 }
      keycap: key
```

**Bundled SFX.** The engine ships 4 sound effects (`click`, `whoosh`, `key`, `chime`) in `audio/sfx/`,
so SFX work out of the box; override them with your own files of the same name, or point `dir` at your
own folder. Resolution works like the music tracks (exact name, alias/slug, or path) and SFX are
**optional** — if a name doesn't resolve, that effect is skipped (the render never fails for a missing
SFX). Default `kind → name` map: `click`/`nav` → `click`, `zoom` → `whoosh`, `keycap` → `key`,
`success` → `chime`; `type`/`move`/`scroll`/`spotlight`/`zoomOut` are muted — so one gesture makes
one sound (the zoom-**in** whooshes, the reset doesn't; the spotlight rides along with its `zoomFit`).
Map any of them explicitly to un-mute. SFX play at a **conservative default gain** (the bundled clips
are loud); raise it with `sfx.gain`. A per-sound cooldown also drops a cue when the same sound is
still playing, so nothing double-hits. The bundled set covers every default kind. See `audio/sfx/README.md`.

---

## 7. Multi-format reframe (`encode.reframe`)

Export extra aspect ratios from the **same** recording — multiplying your reach on social from one
run. The source is scaled to **fit** (no content cropped) and centered over a **blurred,
scaled-up copy of itself** (intentional-looking padding), so 16:9 footage reads naturally as 9:16 or
1:1. Reframes run last, off the finished/composed video, so they inherit the intro/outro, music,
lower-thirds and watermark. Example: `examples/sfx.yml`.

```yaml
encode:
  mp4: out/demo.mp4
  reframe: ['9:16', '1:1']          # → out/demo-9x16.mp4, out/demo-1x1.mp4
  # reframe: { ratios: ['9:16'], opts: { blur: 24 }, out: { '9:16': out/vertical.mp4 } }
```

This is the **blurred-padding** version (not a smart crop that follows the action). Output
dimensions are derived from the source and rounded even (yuv420p-safe).

---

## 8. Outro end-card (`encode.outro`)

The mirror of the intro: an end-card appended **after** the demo with a CTA, repo URL and logo.
Same two engines as the intro (`html` default — `assets/outro.html`, with an animated mesh-gradient
backdrop; or `ffmpeg`). With an outro, the join is a single `intro + demo + outro` concat and the
**music bed spans the whole thing** continuously. Example: `examples/outro.yml`.

```yaml
encode:
  narrateMp4: out/demo.mp4
  ttsOpts: { voice: es-ES-ElviraNeural, music: { track: ambient-gold } }
  intro: { engine: html, title: 'My Web App' }
  outro:
    engine: html              # html | ffmpeg
    result: out/demo-final.mp4
    title: 'Want to try it?'
    subtitle: 'Thanks for watching'
    cta: 'Get started'
    url: 'github.com/me/app'
    bg: '#0B0F1A'
    duration: 3.0
    # logo: assets/logo.png
```

---

## 9. Lower-thirds / chapter titles (`encode.lowerThirds`)

Name each section of the demo with an animated strip (bottom-left, slide-in + fade), rendered with
libass. It reuses the timeline: a `chapter: 'Title'` **step** emits a chapter event, and
`encode.lowerThirds` turns each into a lower-third that lasts `hold` seconds (or until the next
chapter when `hold: 0`). Burned onto the composed final, so it spans correctly with the intro and is
inherited by any reframe. Example: `examples/chapters.yml`.

```yaml
steps:
  - chapter: '1. Ask in natural language'
  # …beat…
  - chapter: '2. Live dashboard'
encode:
  mp4: out/demo.mp4
  lowerThirds:
    hold: 3.0                 # seconds shown (0 = until the next chapter)
    # fontSize: 30, boxColor: '#111418', marginL: 56, marginV: 70, slide: 44, fadeIn/Out: 220
```

---

## 10. Corner watermark / bug (`encode.watermark`)

A persistent corner mark over the whole final video: **text** (via libass) or a **logo PNG** (via
`overlay`). Applied to the composed final, so reframes inherit it. Example: `examples/chapters.yml`.

```yaml
encode:
  mp4: out/demo.mp4
  watermark:
    text: 'My Brand'          # or:  logo: assets/logo.png
    pos: br                   # br | bl | tr | tl
    opacity: 0.5
    # margin: 28, color: '#FFFFFF', fontSize: <auto>
```

---

## 11. Intro templates, typewriter & match-cut

The HTML intro (`engine: html`) gains **themes** and a **typewriter** title, and the intro→demo join
can be a **match-cut** dissolve instead of a hard cut. Example: `examples/match-cut.yml`.

```yaml
encode:
  mp4: out/demo.mp4
  intro:
    engine: html
    template: mesh            # minimal | bold | terminal | mesh
    typewriter: true          # type the title character by character
    title: 'Acme Analytics'
    subtitle: 'data in natural language'
    accent: '#6C5CE7'         # theme accent (mesh blobs, bold subtitle, terminal caret…)
    duration: 2.6
    matchCut: true            # dissolve/zoom intro → demo instead of a hard cut
    result: out/demo-final.mp4
  # transition: { duration: 0.5, transition: fade }   # global: xfade ALL joins (fade|dissolve|fadeblack|wipeleft|…)
```

- **Templates** — `minimal` (soft radial glow, default), `bold` (heavy type over an accent wash),
  `terminal` (monospace `$` prompt with a blinking caret), `mesh` (animated mesh-gradient backdrop).
- **Match-cut** — `intro.matchCut` (or a global `encode.transition`) joins clips with an `xfade`
  zoom-dissolve at the boundary instead of `concat`; the intro's push-in flows into the demo's first
  frame so the cut isn't obvious. Audio is crossfaded too. It is a **dissolve+zoom**, not a
  geometric morph of a logo onto a real element.

---

## 12. Speed ramps (`encode.rampsMp4`)

Deliberate pacing: slow-mo the key moments and speed through the routine. `buildSpeedPlan` reads the
events sidecar and slows windows around the chosen beats (`at`, e.g. `click`/`zoom`) over a brisk
`base` speed; `applySpeedSegments` re-times with the same split→trim→setpts→concat as the idle
speedup. **Video-only, separate output** — re-timing changes the PTS, so burned subs/voice would
desync (produce ramps apart from the narrated cut, like `idleMp4`). Example: `examples/ramps.yml`.

```yaml
encode:
  rampsMp4: out/demo-ramps.mp4
  ramps: { base: 1.5, slowmo: 0.5, at: [click, zoom], window: 0.6 }
```

## 13. Section transitions (`encode.transitions`)

The recording is **continuous**, so there is no hard cut to crossfade within the demo. Instead this
punctuates **section beats** (`nav`/`chapter`) with a stylized `xfade` (zoom-blur, whip, dissolve…):
`transitionAtCuts` splits the composed final at those event times and crossfades the boundaries
(audio `acrossfade`d too). It shortens the clip slightly (overlap per cut). Example:
`examples/transitions.yml`.

```yaml
encode:
  transitions: { at: [nav, chapter], transition: zoomin, duration: 0.4 }
  # transition: any ffmpeg xfade — zoomin | hblur | radial | wipeleft | dissolve | fade…
```

## 14. Karaoke captions (`captionsOpts.karaoke`)

Fill the subtitles **word by word** in sync with the voice. `buildKaraokeAss` takes the TTS word
timings (`getNarration` gives each caption's spoken `duration`), splits the text and emits libass
`\kf` tags weighted by word length; the sung word shows `fillColor`, the rest `color`. Needs the
narration (it pulls it, cached). Example: `examples/karaoke.yml`.

```yaml
encode:
  captionsMp4: out/demo-cc.mp4
  narrateMp4: out/demo.mp4
  captionsOpts: { karaoke: true, style: { fillColor: '#6C5CE7', color: '#FFFFFF', fontSize: 26 } }
```

## 15. Progress bar, colour grade & intro sting

- **Progress bar** — `encode.progressBar` draws a thin bar that grows left→right over the whole clip
  (`drawbox` with a per-frame width expression), on top of everything. `{ color, height, pos: bottom|top }`.
- **Colour grade** — `encode.grade` applies a subtle, consistent look: a `vignette`, `eq` tweaks
  (`contrast`/`saturation`/`brightness`) and an optional 3D LUT (`lut: my.cube`).
- **Intro sting** — `intro.sting: <sfx>` plays a one-shot (e.g. `chime`) at the very start of the
  composed video, via the SFX stage (so it ducks with the music bed). `intro.stingGain` to taste.

```yaml
encode:
  progressBar: { color: '#6C5CE7', height: 6, pos: bottom }
  grade: { vignette: true, contrast: 1.04, saturation: 1.08 }   # + lut: my.cube
  intro: { engine: html, title: 'My Web App', sting: chime }
```

## 16. Smart-crop reframe (follows the action)

`encode.reframe.follow` makes the 9:16 (or any portrait) cut **track the action** instead of just
padding. The recorder tags each `zoom`/`spotlight`/`click` event with the element's rect in video
pixels; `smartReframe` builds a focus timeline and pans a full-height crop window horizontally
(eased, via `piecewiseExpr`) to keep the focus centered, then scales to the target aspect. With no
focus data it falls back to the blurred-padding reframe (§7). Example: `examples/social.yml`.

```yaml
encode:
  mp4: out/demo.mp4
  reframe: { ratios: ['9:16'], follow: true }
```

---

## File reference (engine)

- `src/cursor-kit.js` — the in-page effects (§5): the counter-transformed overlay layer,
  `spotlight`, `keycap`, `annotate`/`highlight`, cursor overshoot/trail, eased `scrollToSel`,
  click variants + `pop`.
- `src/encode.js` — `buildAss`/`burnSubs` (ASS subs), `addMusicBed`/`mixVoiceAndMusic`
  (ducking), `buildIntroFfmpeg`/`concatVideos`/`toMp4Silent` (intro), `probeSize`/`probeHasAudio`,
  `mapSfx`/`muxSfx` (SFX, §6), `reframe`/`aspectToCanvas` (reframe, §7), `buildLowerThirds`/
  `burnLowerThirds` (§9), `burnWatermark` (§10), `xfadeJoin`/`xfadeOffsets` (match-cut, §11),
  `idleSegments`/`applySpeedSegments`/`buildSpeedPlan` (ramps, §12), `transitionAtCuts` (§13),
  `buildKaraokeAss`/`burnKaraoke` (§14), `addProgressBar`/`colorGrade` (§15),
  `smartReframe`/`piecewiseExpr` (§16).
- `src/recorder.js` — the `Driver` step vocabulary + `mark()`, which writes the
  `<video>.events.json` sidecar (it tags zoom/spotlight/click events with the element rect for the
  smart-crop) consumed by the SFX, lower-thirds, ramps, transitions and reframe stages.
- `src/tracks.js` — `resolveTrack` (music) and `resolveSfx` (optional SFX, returns null on miss).
- `src/tts.js` — `getNarration` (voice timings) + `musicEnvelope` (with intro `offset`).
- `src/run.js` — `applyEncode` orchestrates the stages: intro/outro bookends (or match-cut
  `xfadeJoin`), the continuous music bed, SFX, lower-thirds + watermark, and reframes.
- `assets/intro.html` / `assets/outro.html` — the HTML intro (themes/typewriter) and outro cards.
