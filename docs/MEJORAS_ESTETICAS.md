# Mejoras estéticas del demo-recorder

Guía de las cuatro mejoras estéticas: **elección de pistas**, **subtítulos estilizados**,
**intro de marca** y **música de fondo con ducking**. Todo se configura desde el bloque
`encode:` del `.yml`. Para el contexto y las decisiones de diseño, ver también el plan en
`~/.claude/plans/`.

Ejemplos listos para ejecutar:

| Ejemplo | Qué muestra |
|---------|-------------|
| `examples/voice-only.yml`  | Vídeo + audio **sin** subtítulos |
| `examples/styled-subs.yml` | Subtítulos "trazo limpio" (sin caja) + fades |
| `examples/intro-music.yml` | Intro + voz + subs + música con ducking |

```bash
node examples/mock-server.mjs           # backend determinista (127.0.0.1:4317)
demo-recorder run examples/intro-music.yml
demo-recorder frames out/intro-demo-intro.mp4   # contact-sheet para revisar
```

---

## 1. Elegir pistas (las 4 combinaciones)

No hay clave nueva: se combinan las claves de `encode`. Los pasos `caption:` siempre graban
sus tiempos; que se **oigan** (voz) o se **vean** (subs) depende de qué claves actives.

| Modo | Claves `encode` | Notas |
|------|-----------------|-------|
| **Solo vídeo** | `mp4` (o `idleMp4`) | Sin audio ni subs |
| **Vídeo + audio** | `narrateMp4` + `ttsOpts` | Sin `captionsMp4`: la voz sale de los `caption:` pero no se quema. Receta: `voice-only.yml` |
| **Vídeo + subs** | `captionsMp4` + `captionsOpts` | Subtítulos quemados, sin voz. Receta: `styled-subs.yml` |
| **Vídeo + audio + subs** | `captionsMp4` + `narrateMp4` | `narrateMp4` narra sobre el vídeo ya subtitulado |

Clave: `narrateVideo` usa `captionsMp4` como base si existe, y si no, el vídeo limpio — por
eso "audio sin subs" funciona sin nada extra.

---

## 2. Subtítulos estilizados (sin caja negra)

`captionsOpts.style` controla el aspecto. Si es un **objeto** → se genera un `.ass` y se quema
con libass (trazo, fades, easing). Si es un **string** → modo legacy `force_style` sobre SRT
(retrocompatible). Por defecto (sin `style`): **"trazo limpio"**.

```yaml
encode:
  captionsMp4: out/demo.mp4
  captionsOpts:
    style:
      font: Segoe UI          # nombre de la fuente (FontName)
      fontFile: C:/Windows/Fonts/segoeui.ttf   # opcional: solo si NO está instalada
      fontSize: 24            # px sobre referencia de 800 de alto (escala con el vídeo)
      color: '#FFFFFF'        # color del texto
      outlineColor: '#101010' # color del TRAZO/borde
      outline: 2              # grosor del trazo (px)
      shadow: 0.5             # sombra suave (0 = sin sombra)
      bold: false
      alignment: 2            # numpad ASS: 2 = abajo-centro, 8 = arriba-centro
      marginV: 48             # margen vertical
      fadeIn: 200             # ms de fundido de entrada
      fadeOut: 200            # ms de fundido de salida
      slideUp: 0              # opcional: px de deslizamiento de entrada (ease)
```

Notas:
- **Sin fondo:** se usa `BorderStyle=1` (trazo + sombra), no la caja opaca `BorderStyle=3`.
- **Fades:** cada cue lleva `{\fad(fadeIn,fadeOut)}`. Con `slideUp>0` se añade un `\move`
  para una entrada que sube (aproximación de easing con libass).
- **Tamaño consistente:** `fontSize`/márgenes se autoría sobre una referencia de 800 px de
  alto; libass los escala al tamaño real (con `scale: 2` el vídeo es 2× y los subs también).
- **Fuente no instalada:** indica `fontFile`; se copia junto al `.ass` y se carga vía
  `fontsdir` (sortea el escape de `:` de unidad en Windows). El `font:` debe coincidir con el
  nombre de familia de la fuente.

---

## 3. Intro de marca (logo + título + animación)

`encode.intro` antepone una intro al mp4 final. Dos motores:

```yaml
encode:
  narrateMp4: out/demo.mp4
  intro:
    engine: ffmpeg          # ffmpeg (tarjeta compuesta) | html (plantilla grabada)
    prependTo: out/demo.mp4 # mp4 al que se antepone (por defecto: el último producido)
    result: out/demo-intro.mp4
    duration: 2.8
    logo: assets/logo.png   # PNG con transparencia (opcional)
    title: 'Mi Web App'
    subtitle: 'tu eslogan'  # opcional
    bg: '#0B0F1A'           # color de fondo
    fg: '#FFFFFF'           # color de texto (solo motor html)
    animation: fade-zoom    # fade | fade-zoom
    music: audio/bg/4.-Ambient-Gold.mp3   # opcional: música solo en la intro
```

- **`engine: ffmpeg`** (por defecto): compone fondo + logo + título + subtítulo con `drawtext`,
  fade-in/out y un zoom sutil. Determinista y rápido, sin navegador. Se construye al tamaño
  exacto del vídeo destino.
- **`engine: html`**: renderiza `assets/intro.html` (animaciones CSS más ricas) y la graba con
  el mismo motor Playwright. Personaliza esa plantilla para tu marca.
- La concatenación re-codifica (robusta entre codificadores distintos) y mantiene audio solo si
  **todas** las partes lo tienen (una salida solo-subs o solo-vídeo no tiene audio → resultado
  mudo, coherente).

---

## 4. Música de fondo con ducking

Cama musical bajo la voz, con envolvente calculada desde los tiempos reales de cada TTS. Se
aplica como **capa final continua** sobre todo el vídeo: si hay intro, la música **empieza con
la intro** (a volumen alto) y sigue sin cortes hacia la demo. Se configura en `ttsOpts.music`
(o `encode.music`).

**Pistas incluidas (funciona desde cualquier proyecto).** El motor trae 3 pistas con licencia
libre en su `audio/bg/`; no hace falta copiarlas a tu proyecto. En `track` pon un **alias**
(`ambient-gold`, `sidewalk-chalk`, `she-said-i-wonder`), el nombre del archivo, o una **ruta** a
tu propio audio. Si omites `track` usa la *ambient* por defecto; `music: true` = default +
ducking por defecto. Lista los alias con `demo-recorder tracks`.

```yaml
encode:
  narrateMp4: out/demo.mp4
  ttsOpts:
    voice: es-ES-ElviraNeural
    music:
      track: ambient-gold   # alias bundled · o sidewalk-chalk / she-said-i-wonder · o ruta propia
      full: 0.85       # volumen alto (huecos largos, antes y después)
      duck: 0.16       # volumen bajo (durante la voz)
      lead: 1.2        # s: baja ANTES de cada TTS (bajada anticipada)
      tail: 0.8        # s: tarda en subir tras cada TTS
      gapRaise: 3.0    # s: hueco mínimo entre TTS para volver a 'full'
      ramp: 0.4        # s: duración de cada rampa de subida/bajada
      fadeIn: 1.0      # s: fundido de entrada al inicio
      fadeOut: 1.5     # s: fundido de salida al final
```

Comportamiento de la envolvente:

```
vol │█████▁▁▁▁▁█████▁▁▁▁▁████████
    └──────────────────────────► t
    full   duck   full   duck   full
    (fadeIn) (voz) (hueco≥gapRaise) (voz) (fin, fadeOut)
```

- La música arranca en `full` (con `fadeIn`) y **baja antes** del primer TTS gracias a `lead`.
- Dos TTS separados por **menos** de `gapRaise` mantienen el duck (la música no sube en huecos
  cortos); con un hueco ≥ `gapRaise` sube a `full`.
- Tras el último TTS vuelve a `full`, con `fadeOut` al final del vídeo.
- **Con intro:** los tiempos de voz se desplazan por la duración de la intro, así que la cama
  cubre `intro + demo` de forma continua (la intro suena a `full`, sin reinicios en el corte).
- **Solo música (sin captions):** si defines `music` pero no hay `caption:`, obtienes una cama
  musical plana a `full` con fades.

La pista se reproduce en bucle para cubrir todo el vídeo, así que no necesita durar tanto como
el clip.

---

## Referencia de archivos (motor)

- `src/encode.js` — `buildAss`/`burnSubs` (subs ASS), `addMusicBed`/`mixVoiceAndMusic`
  (ducking), `buildIntroFfmpeg`/`concatVideos`/`toMp4Silent` (intro), `probeSize`/`probeHasAudio`.
- `src/tts.js` — `getNarration` (tiempos de voz) + `musicEnvelope` (con `offset` de intro).
- `src/run.js` — `applyEncode` orquesta las etapas y aplica la música como capa final continua
  (intro + cama); `buildIntroClip`/`recordIntroHtml` (motores de intro).
- `assets/intro.html` — plantilla de la intro HTML.
