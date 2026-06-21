# Mejoras estéticas del demo-recorder

> 🌐 [English](AESTHETICS.md) · **Español**

Guía de las opciones estéticas. Las cuatro primeras (**elección de pistas**, **subtítulos
estilizados**, **intro de marca**, **música de fondo con ducking**) se configuran desde el bloque
`encode:`. El resto son **efectos de coreografía in-page** (dibujados en vivo durante la grabación,
§5) y más efectos de **post-producción** (SFX, reencuadre, outro, lower-thirds, watermark, plantillas
de intro y match-cut; §6–§11). Para el contexto y las decisiones de diseño, ver también el plan en
`~/.claude/plans/`.

Ejemplos listos para ejecutar:

| Ejemplo | Qué muestra |
|---------|-------------|
| `examples/voice-only.yml`  | Vídeo + audio **sin** subtítulos |
| `examples/styled-subs.yml` | Subtítulos "trazo limpio" (sin caja) + fades |
| `examples/intro-music.yml` | Intro + voz + subs + música con ducking |
| `examples/effects.yml`     | Spotlight, keycaps, scroll suave, variantes de click |
| `examples/annotate.yml`    | Callouts (arrow/box/circle) + barrido de resaltado |
| `examples/sfx.yml`         | SFX sincronizados con los pasos + reencuadre (9:16, 1:1) |
| `examples/chapters.yml`    | Lower-thirds (títulos de capítulo) + watermark |
| `examples/outro.yml`       | Intro + demo + outro con una misma cama musical continua |
| `examples/match-cut.yml`   | Plantilla de intro animada + match-cut hacia la demo |
| `examples/ramps.yml`       | Speed ramps deliberadas (slow-mo en los beats clave, ágil en el resto) |
| `examples/transitions.yml` | Transiciones estilizadas entre secciones (nav/chapter) |
| `examples/karaoke.yml`     | Subtítulos karaoke palabra a palabra en sync con el TTS |
| `examples/social.yml`      | Smart-crop 9:16 (sigue la acción) + barra de progreso + grade |

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
      font: Inter             # fuente empacada por defecto (cross-platform, sin instalar nada)
      # font: MiFuente        # + fontFile para usar una tipografía propia (su nombre de familia)
      # fontFile: ./assets/MiFuente.ttf   # ruta a tu .ttf; se carga vía fontsdir (sin instalar)
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
- **Fuente por defecto:** **Inter** (empacada en `fonts/`), así el render es idéntico en
  Windows/macOS/Linux sin depender de fuentes del sistema. Inter (regular + bold) se carga siempre
  vía `fontsdir`, sin instalar nada.
- **Fuente propia:** indica `fontFile` (ruta a tu `.ttf`); se copia junto al `.ass` y se carga vía
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
    # font: Inter           # (solo motor ffmpeg) fuente; por defecto Inter empacada
    # fontBold: ./assets/MiFuente-Bold.ttf   # opcional: variante bold para el título
    music: audio/bg/4.-Ambient-Gold.mp3   # opcional: música solo en la intro
```

- **`engine: ffmpeg`** (por defecto): compone fondo + logo + título + subtítulo con **libass**,
  fade-in/out y un zoom sutil. Determinista y rápido, sin navegador. Se construye al tamaño
  exacto del vídeo destino. La tipografía es **Inter** empacada (cross-platform); sobrescríbela con
  `font` (subtítulo/regular) y `fontBold` (título) — una ruta, un nombre empacado o un alias (cada
  fuente se copia junto al `.ass` antes de renderizar, así que pueden estar en cualquier ruta).
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

## 5. Efectos de atención in-page (en vivo durante la grabación)

Estos son **pasos**, no claves de `encode` — los dibuja la capa inyectada mientras grabas, así que
aparecen en el contact-sheet sin pasada de encode. Se renderizan sobre un overlay en espacio de
pantalla que está contra-transformado respecto al zoom de cámara, así que **siguen el elemento
correctamente incluso a mitad de zoom**. La referencia del esquema de cada paso está en
[GUIA_DE_USO.md §3](GUIA_DE_USO.md#3-el-esquema-del-guión-yaml); recetas de ejemplo:
`examples/effects.yml` y `examples/annotate.yml`.

- **Spotlight / máscara de atención** — atenúa todo menos un elemento (el look de Screen Studio).
  Úsalo suelto (`spotlight: { sel, dim }`) o acoplado a un auto-zoom (`zoomFit: { sel, spotlight: true }`).
  `spotlightOff` lo quita; `resetZoom` lo quita automáticamente. Mejor sobre lo único que el
  espectador debe mirar — un resultado, un botón, un KPI.
- **Keycaps** — muestra atajos pulsados como cápsulas (`keycap: 'cmd+k'` → ⌘ + K), con glifos mapeados
  (`cmd`→⌘, `enter`→⏎, `shift`→⇧…). Esencial para apps guiadas por atajos. Nota: el tecleo despacha
  eventos de input, no pulsaciones reales, así que las keycaps se **declaran**, no se capturan —
  añádelas donde quieras mostrar la tecla.
- **Callouts / anotaciones** — `annotate: { sel, shape, text, side, color }` dibuja una flecha / caja /
  círculo anclado a un elemento, con una etiqueta opcional. Convierte una demo en casi un tutorial.
  `annotateOff` (y `resetZoom`) los quitan.
- **Barrido de resaltado** — `highlight: { sel, mode }` barre un marcador animado (`marker`, blend
  multiply) o `underline` sobre una frase o un valor.
- **Pulido del cursor y el click** — `move: { overshoot, trail }` da al cursor un pequeño rebote al
  llegar y un trail que se desvanece; `scroll: { sel, ms }` desplaza la página con easing (un salto
  de scroll brusco es el típico delator de que una demo está scripteada); `click` gana
  `variant: single|double|right`, un anillo `ripple` y un `pop` (el elemento se escala brevemente al
  interactuar).

---

## 6. SFX sincronizados con los pasos (`encode.sfx`)

Efectos de sonido cortos de un disparo colocados sobre los **beats grabados** —clicks, zooms,
keycaps— y mezclados **encima** de la música (ya con ducking). El recorder escribe un sidecar
`<video>.events.json` con un timestamp por cada beat visual; la etapa de SFX mapea cada `kind` a un
sonido y los inserta con `adelay`+`amix` (`normalize=0`, así se preserva el nivel de la cama). Cuando
se antepone una intro, los tiempos de evento se desplazan por la duración de la intro para que los
SFX sigan sincronizados. Ejemplo: `examples/sfx.yml`.

```yaml
encode:
  narrateMp4: out/demo.mp4
  ttsOpts: { voice: es-ES-ElviraNeural, music: { track: ambient-gold } }
  sfx:
    gain: 0.8                 # ganancia global (0..1+)
    # dir: assets/sfx         # opcional: tu propia carpeta de SFX
    map:                      # sobrescribe el mapa kind → sonido (null silencia un kind)
      click: click
      zoom: { name: whoosh, gain: 0.5 }
      keycap: key
```

**SFX incluidos.** El motor ya trae 4 efectos (`click`, `whoosh`, `key`, `chime`) en `audio/sfx/`, así
que los SFX funcionan de fábrica; sobrescríbelos con los tuyos (mismos nombres) o apunta `dir` a tu
propia carpeta. La resolución funciona como las pistas de música (nombre exacto, alias/slug o ruta) y
los SFX son **opcionales** — si un nombre no resuelve, ese efecto se salta (el render nunca falla por
un SFX que falta). Mapa por defecto `kind → name`: `click`/`nav` → `click`, `zoom` → `whoosh`,
`keycap` → `key`, `success` → `chime`; `type`/`move`/`scroll`/`spotlight`/`zoomOut` van silenciados —
así un gesto hace un solo sonido (el zoom-**in** suena, el reset no; el spotlight acompaña a su
`zoomFit`). Mapea cualquiera explícitamente para activarlo. Los SFX suenan a un **gain conservador
por defecto** (los clips incluidos son fuertes); súbelo con `sfx.gain`. Además, un cooldown por
sonido descarta una cue si ese mismo sonido sigue sonando, para que nada se oiga doble. El set
incluido cubre todos los kinds por defecto. Ver `audio/sfx/README.md`.

---

## 7. Reencuadre multi-formato (`encode.reframe`)

Exporta relaciones de aspecto extra desde la **misma** grabación — multiplicando tu alcance en redes
desde una sola toma. La fuente se escala para **encajar** (sin recortar contenido) y se centra sobre
una **copia de sí misma difuminada y agrandada** (un relleno que parece intencional), así un metraje
16:9 se lee con naturalidad como 9:16 o 1:1. Los reencuadres van al final, sobre el vídeo ya
terminado/compuesto, así que heredan la intro/outro, la música, los lower-thirds y el watermark.
Ejemplo: `examples/sfx.yml`.

```yaml
encode:
  mp4: out/demo.mp4
  reframe: ['9:16', '1:1']          # → out/demo-9x16.mp4, out/demo-1x1.mp4
  # reframe: { ratios: ['9:16'], opts: { blur: 24 }, out: { '9:16': out/vertical.mp4 } }
```

Esta es la versión de **relleno difuminado** (no un recorte inteligente que sigue la acción). Las
dimensiones de salida se derivan de la fuente y se redondean a pares (compatible con yuv420p).

---

## 8. Outro de cierre (`encode.outro`)

El espejo de la intro: una tarjeta de cierre añadida **después** de la demo con un CTA, la URL del
repo y el logo. Los mismos dos motores que la intro (`html` por defecto — `assets/outro.html`, con un
fondo de gradiente mesh animado; o `ffmpeg`). Con un outro, la unión es un único concat
`intro + demo + outro` y la **cama musical abarca todo** de forma continua. Ejemplo: `examples/outro.yml`.

```yaml
encode:
  narrateMp4: out/demo.mp4
  ttsOpts: { voice: es-ES-ElviraNeural, music: { track: ambient-gold } }
  intro: { engine: html, title: 'Mi Web App' }
  outro:
    engine: html              # html | ffmpeg
    result: out/demo-final.mp4
    title: '¿Quieres probarlo?'
    subtitle: 'Gracias por ver el vídeo'
    cta: 'Empieza ya'
    url: 'github.com/me/app'
    bg: '#0B0F1A'
    duration: 3.0
    # logo: assets/logo.png
```

---

## 9. Lower-thirds / títulos de capítulo (`encode.lowerThirds`)

Nombra cada sección de la demo con una tira animada (abajo a la izquierda, slide-in + fade),
renderizada con libass. Reutiliza la línea de tiempo: un **paso** `chapter: 'Título'` emite un evento
de capítulo, y `encode.lowerThirds` convierte cada uno en un lower-third que dura `hold` segundos (o
hasta el siguiente capítulo cuando `hold: 0`). Quemado sobre el final ya compuesto, así que abarca
correctamente con la intro y lo hereda cualquier reencuadre. Ejemplo: `examples/chapters.yml`.

```yaml
steps:
  - chapter: '1. Pregunta en lenguaje natural'
  # …beat…
  - chapter: '2. Dashboard en vivo'
encode:
  mp4: out/demo.mp4
  lowerThirds:
    hold: 3.0                 # segundos visible (0 = hasta el siguiente capítulo)
    # fontSize: 30, boxColor: '#111418', marginL: 56, marginV: 70, slide: 44, fadeIn/Out: 220
```

---

## 10. Watermark / marca de agua en la esquina (`encode.watermark`)

Una marca persistente en la esquina sobre todo el vídeo final: **texto** (vía libass) o un **PNG de
logo** (vía `overlay`). Se aplica al final ya compuesto, así que los reencuadres la heredan. Ejemplo:
`examples/chapters.yml`.

```yaml
encode:
  mp4: out/demo.mp4
  watermark:
    text: 'Mi Marca'          # o:  logo: assets/logo.png
    pos: br                   # br | bl | tr | tl
    opacity: 0.5
    # margin: 28, color: '#FFFFFF', fontSize: <auto>
```

---

## 11. Plantillas de intro, typewriter y match-cut

La intro HTML (`engine: html`) gana **temas** y un título con **máquina de escribir**, y la unión
intro→demo puede ser una disolvencia **match-cut** en vez de un corte seco. Ejemplo: `examples/match-cut.yml`.

```yaml
encode:
  mp4: out/demo.mp4
  intro:
    engine: html
    template: mesh            # minimal | bold | terminal | mesh
    typewriter: true          # teclea el título carácter a carácter
    title: 'Acme Analytics'
    subtitle: 'datos en lenguaje natural'
    accent: '#6C5CE7'         # acento del tema (blobs mesh, subtítulo bold, caret de terminal…)
    duration: 2.6
    matchCut: true            # disuelve/zoom intro → demo en vez de un corte seco
    result: out/demo-final.mp4
  # transition: { duration: 0.5, transition: fade }   # global: xfade TODAS las uniones (fade|dissolve|fadeblack|wipeleft|…)
```

- **Plantillas** — `minimal` (glow radial suave, por defecto), `bold` (tipografía pesada sobre un baño
  de acento), `terminal` (prompt `$` monoespaciado con caret parpadeante), `mesh` (fondo de gradiente
  mesh animado).
- **Match-cut** — `intro.matchCut` (o un `encode.transition` global) une los clips con un `xfade`
  zoom-disolvencia en el límite en vez de `concat`; el push-in de la intro fluye hacia el primer frame
  de la demo, así que el corte no es obvio. El audio también va con crossfade. Es una
  **disolvencia+zoom**, no un morph geométrico de un logo sobre un elemento real.

---

## 12. Speed ramps (`encode.rampsMp4`)

Ritmo deliberado: pon en cámara lenta los momentos clave y pasa rápido por la rutina. `buildSpeedPlan`
lee el sidecar de eventos y ralentiza ventanas alrededor de los beats elegidos (`at`, p. ej.
`click`/`zoom`) sobre una velocidad `base` ágil; `applySpeedSegments` re-temporiza con el mismo
split→trim→setpts→concat que el acelerado de huecos. **Solo-vídeo, salida aparte** — el re-timing cambia
los PTS, así que subs/voz quemados se desincronizarían (saca las rampas aparte del corte narrado, como
`idleMp4`). Ejemplo: `examples/ramps.yml`.

```yaml
encode:
  rampsMp4: out/demo-ramps.mp4
  ramps: { base: 1.5, slowmo: 0.5, at: [click, zoom], window: 0.6 }
```

## 13. Transiciones de sección (`encode.transitions`)

La grabación es **continua**, así que no hay un corte seco que disolver dentro de la demo. En su lugar,
esto puntúa los **beats de sección** (`nav`/`chapter`) con un `xfade` estilizado (zoom-blur, whip,
disolvencia…): `transitionAtCuts` parte el final compuesto en esos tiempos de evento y aplica crossfade
en los límites (el audio también con `acrossfade`). Acorta ligeramente el clip (solape por corte).
Ejemplo: `examples/transitions.yml`.

```yaml
encode:
  transitions: { at: [nav, chapter], transition: zoomin, duration: 0.4 }
  # transition: cualquier xfade de ffmpeg — zoomin | hblur | radial | wipeleft | dissolve | fade…
```

## 14. Subtítulos karaoke (`captionsOpts.karaoke`)

Rellena los subtítulos **palabra a palabra** en sync con la voz. `buildKaraokeAss` toma los tiempos de
palabra del TTS (`getNarration` da la `duration` hablada de cada caption), parte el texto y emite tags
libass `\kf` ponderados por la longitud de cada palabra; la palabra cantada muestra `fillColor`, el
resto `color`. Necesita la narración (la obtiene, cacheada). Ejemplo: `examples/karaoke.yml`.

```yaml
encode:
  captionsMp4: out/demo-cc.mp4
  narrateMp4: out/demo.mp4
  captionsOpts: { karaoke: true, style: { fillColor: '#6C5CE7', color: '#FFFFFF', fontSize: 26 } }
```

## 15. Barra de progreso, color grade y sting de intro

- **Barra de progreso** — `encode.progressBar` dibuja una barra fina que crece de izquierda a derecha
  sobre todo el clip (`drawbox` con una expresión de ancho por frame), encima de todo.
  `{ color, height, pos: bottom|top }`.
- **Color grade** — `encode.grade` aplica un look sutil y consistente: una `vignette`, ajustes de `eq`
  (`contrast`/`saturation`/`brightness`) y una LUT 3D opcional (`lut: my.cube`).
- **Sting de intro** — `intro.sting: <sfx>` reproduce un disparo (p. ej. `chime`) justo al inicio del
  vídeo compuesto, vía la etapa de SFX (así hace ducking con la cama musical). `intro.stingGain` al gusto.

```yaml
encode:
  progressBar: { color: '#6C5CE7', height: 6, pos: bottom }
  grade: { vignette: true, contrast: 1.04, saturation: 1.08 }   # + lut: my.cube
  intro: { engine: html, title: 'Mi Web App', sting: chime }
```

## 16. Smart-crop reframe (sigue la acción)

`encode.reframe.follow` hace que el recorte 9:16 (o cualquier vertical) **siga la acción** en vez de solo
rellenar. El recorder etiqueta cada evento `zoom`/`spotlight`/`click` con el rect del elemento en píxeles
de vídeo; `smartReframe` construye una línea de foco y desplaza horizontalmente (con easing, vía
`piecewiseExpr`) una ventana de recorte a altura completa para mantener el foco centrado, y luego escala
al aspecto destino. Sin datos de foco, recae en el reencuadre de relleno difuminado (§7). Ejemplo:
`examples/social.yml`.

```yaml
encode:
  mp4: out/demo.mp4
  reframe: { ratios: ['9:16'], follow: true }
```

---

## Referencia de archivos (motor)

- `src/cursor-kit.js` — los efectos in-page (§5): la capa overlay contra-transformada,
  `spotlight`, `keycap`, `annotate`/`highlight`, overshoot/trail del cursor, `scrollToSel` con
  easing, variantes de click + `pop`.
- `src/encode.js` — `buildAss`/`burnSubs` (subs ASS), `addMusicBed`/`mixVoiceAndMusic`
  (ducking), `buildIntroFfmpeg`/`concatVideos`/`toMp4Silent` (intro), `probeSize`/`probeHasAudio`,
  `mapSfx`/`muxSfx` (SFX, §6), `reframe`/`aspectToCanvas` (reencuadre, §7), `buildLowerThirds`/
  `burnLowerThirds` (§9), `burnWatermark` (§10), `xfadeJoin`/`xfadeOffsets` (match-cut, §11),
  `idleSegments`/`applySpeedSegments`/`buildSpeedPlan` (ramps, §12), `transitionAtCuts` (§13),
  `buildKaraokeAss`/`burnKaraoke` (§14), `addProgressBar`/`colorGrade` (§15),
  `smartReframe`/`piecewiseExpr` (§16).
- `src/recorder.js` — el vocabulario de pasos del `Driver` + `mark()`, que escribe el sidecar
  `<video>.events.json` (etiqueta los eventos zoom/spotlight/click con el rect del elemento para el
  smart-crop) que consumen las etapas de SFX, lower-thirds, ramps, transiciones y reencuadre.
- `src/tracks.js` — `resolveTrack` (música) y `resolveSfx` (SFX opcionales, devuelve null si no casa).
- `src/tts.js` — `getNarration` (tiempos de voz) + `musicEnvelope` (con `offset` de intro).
- `src/run.js` — `applyEncode` orquesta las etapas: intro/outro como marcos (o `xfadeJoin` del
  match-cut), la cama musical continua, los SFX, lower-thirds + watermark, y los reencuadres.
- `assets/intro.html` / `assets/outro.html` — la intro HTML (temas/typewriter) y las tarjetas de outro.
