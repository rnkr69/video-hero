# Aesthetic options in demo-recorder

> 🌐 **English** · [Español](MEJORAS_ESTETICAS.md)

Guide to the four aesthetic options: **track selection**, **styled subtitles**,
**brand intro card** and **background music with ducking**. Everything is configured from the
`encode:` block of the script. For context and design decisions, see also the plan in
`~/.claude/plans/`.

Ready-to-run examples:

| Example | What it shows |
|---------|-------------|
| `examples/voice-only.yml`  | Video + audio **without** subtitles |
| `examples/styled-subs.yml` | "Clean stroke" subtitles (no box) + fades |
| `examples/intro-music.yml` | Intro + voice + subs + music with ducking |

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

## File reference (engine)

- `src/encode.js` — `buildAss`/`burnSubs` (ASS subs), `addMusicBed`/`mixVoiceAndMusic`
  (ducking), `buildIntroFfmpeg`/`concatVideos`/`toMp4Silent` (intro), `probeSize`/`probeHasAudio`.
- `src/tts.js` — `getNarration` (voice timings) + `musicEnvelope` (with intro `offset`).
- `src/run.js` — `applyEncode` orchestrates the stages and applies the music as a continuous
  final layer (intro + bed); `buildIntroClip`/`recordIntroHtml` (intro engines).
- `assets/intro.html` — the HTML intro template.
