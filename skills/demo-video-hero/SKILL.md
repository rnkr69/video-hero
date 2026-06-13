---
name: demo-video-hero
description: >-
  Graba un vídeo hero/demo determinista de CUALQUIER web app con la CLI global
  `demo-recorder` (Playwright recordVideo + cursor/zoom sintéticos + ffmpeg + voz TTS).
  Úsalo cuando el usuario pida "graba un vídeo de la app", "haz un clip/demo de
  producto", "vídeo hero para el README", o quiera iterar un guión de grabación; y
  también para retocar la estética de un demo: "ponle una intro con logo/título",
  "subtítulos bonitos / sin caja negra / con trazo y fades", "añade voz/narración",
  "música de fondo con ducking", o "elige qué pistas lleva (vídeo/audio/subs)".
  Funciona desde el proyecto actual: escribes el .yml aquí (conoces la web) y la CLI
  ejecuta el motor instalado aparte. Conduce el loop grabar → contact-sheet → mirar
  los frames → ajustar.
---

# demo-video-hero

Graba vídeos de producto **fluidos y deterministas** de una web app. El motor está
instalado como **CLI global `demo-recorder`** (no necesitas su código en este proyecto).
Tu trabajo como agente: **escribir/ajustar el guión `.yml`** en el proyecto actual (que
conoce la web: URL, selectores, login) y **cerrar el loop de auto-verificación por
frames** sin que el usuario mire el vídeo en directo.

Comprueba que la CLI está disponible: `demo-recorder help`. Si no existe, el motor está
en otra carpeta; instálalo con `npm link` allí (o usa `node <ruta>/src/run.js`).

## El loop EFICIENTE (3 fases — no encodees mientras iteras)

El encode (TTS/subtítulos) tarda 30–60 s y es **puro desperdicio en cada toma fallida**.
Separa las fases:

1. **Escribe el guión** `.yml` en el proyecto actual (empieza corto). Apunta `url` a la
   app real; si tiene datos dinámicos/streaming, fíjalos con `route`. Sin app propia:
   `demo-recorder mock` levanta una demo en `127.0.0.1:4317`.

2. **PROBE primero** (lo que más acelera) — valida selectores/auth en ~10 s SIN grabar:
   `demo-recorder probe mi-demo.yml`
   Corre los pasos en headed, **para en el primer fallo y vuelca el DOM y el porqué**
   (qué parte del selector resolvió, los hijos disponibles, elementos visibles). Arregla
   selectores/`waitFor`/login aquí antes de grabar nada. Itera un solo beat: `--from N --to M`.

3. **RECORD para afinar timing/zoom** (rápido, sin encode):
   `demo-recorder record mi-demo.yml` → `VIDEO: <out>/raw/page@<hash>.webm`
   Luego **mira el contact-sheet**: `demo-recorder frames <out>/raw/page@<hash>.webm` → genera
   `<out>/frames/contact-<vídeo>.png` con frames **con timestamp quemado**. **Ábrelo con Read**
   y comprueba cursor, typing, render y encuadre del zoom. Ajusta `hold`/`zoomFit`/`cps` y
   repite. (Itera un beat con `record --from N --to M`.)

4. **ENCODE una sola vez al final** — voz/subtítulos/mp4 sobre el último webm:
   `demo-recorder encode mi-demo.yml`   (o `demo-recorder run mi-demo.yml` = record+encode)

Las rutas son relativas a la carpeta actual; las salidas caen en este proyecto. La carpeta
`out/` se autoordena: **finales sueltos en `out/`**, grabaciones en `out/raw/` (últimas 3),
contact-sheets en `out/frames/`, intermedios en `out/work/` (se autolimpian). Purga a demanda:
`demo-recorder clean` (`--all` deja solo finales).

## Esquema YAML (pasos)

Campos raíz: `url`, `width` (1280), `height` (800), `scale` (2), `headless` (true),
`out` (`out`), `autoZoom` (false), `waitTimeout` (ms, def 20000 — **súbelo a 45000 para
apps con LLM/streaming**), `probeTimeout` (ms para `probe`, def 10000), `keepRaw` (cuántas
grabaciones conservar, def 3), `storageState`, `login`, `route` (modo app real), y opcional
`encode: { srt, captionsMp4, captionsOpts, narrateMp4, ttsOpts, music, intro, idleMp4, mp4,
gif }`. Cualquier `${VAR}` en strings se sustituye desde el entorno.

`steps` es una lista; cada item es **una sola acción**:

```yaml
- hold: 800                                              # esperar ms
- type: { sel: 'host >>> textarea', text: '…', cps: 38 } # teclear char-a-char
- click: 'sel'                                           # click con cursor+pulse
- click: { sel: 'nav a', nav: true }                    # click que NAVEGA de página
- move: 'sel'                                            # mover cursor a un elemento
- zoomTo: { sel: 'sel', scale: 1.25, ms: 850 }          # zoom MANUAL (escala fija)
- zoomFit: 'sel'                                         # AUTO-ZOOM: escala desde el bbox
- zoomFit: { sel: 'sel', fill: 0.9, max: 2.2, ms: 850 } #   (centra y clampa los bordes)
- resetZoom: true                                        # volver a 1x
- caption: 'Texto del subtítulo'                         # caption desde aquí…
- caption: ''                                            # …vacío = quitar caption
- waitFor: 'sel'                                         # esperar selector (Playwright)
- goto: 'https://…'                                      # navegar por URL
```

### Auto-zoom (estilo Screen Studio)

Prefiere `zoomFit` a `zoomTo`: deriva la escala del bounding box del elemento (los
pequeños se acercan más, tope `max`), lo centra y **clampa la traslación** para no
mostrar bordes vacíos. `fill` (0..1, def .78) = cuánto del viewport ocupa el elemento.
También al hacer click: `click: { sel:'.card', zoom:true }` (encuadra el clicado),
`zoom:'#detalle'` (encuadra otro), `zoom:1.4` (escala fija). O `autoZoom: true` en raíz.
Para resultados que aparecen tras streaming, usa `waitFor` + `zoomFit` (no zoom-en-click).

## Selectores y shadow DOM (gotcha clave)

- En `type/click/move/zoomTo/zoomFit` (capa inyectada) usa `host >>> inner` para
  **atravesar shadow roots** (web components). Ej: `mi-widget >>> textarea`.
- En `waitFor` (Playwright) usa **CSS normal**; Playwright atraviesa shadow roots
  abiertos solo. Ej: `mi-widget table`.
- Trampa típica: `waitFor: 'mi-widget table'` PERO `zoomFit: 'mi-widget >>> table'`.

## Apps con chat / streaming (LLM) — patrón universal

- **Sube `waitTimeout` a 45000** en la raíz: 20 s se queda corto para respuestas de LLM.
- **Antes de enviar el siguiente mensaje, espera a que el botón de enviar se RE-HABILITE**
  (señal fiable de "terminó de streamear"): `waitFor: 'button.send:not([disabled])'`. No te
  fíes solo de que aparezca texto. Otras señales válidas: desaparición del cursor de
  streaming, aparición del bloque final.
- Para que el streaming se vea incremental (no "de golpe"), `route.fulfill` NO sirve
  (entrega el body de una vez): usa un mock SSE con `sleep` entre chunks y `redirect` hacia él.

## Preflight (te avisa de las trampas)

`probe`/`record`/`run` avisan por consola si `url` no casa con `$APP_URL` (la clásica
trampa **127.0.0.1 ↔ localhost**, que rompe cookies/CSRF en Laravel y similares), o si
tras navegar acabas en otro host o en una pantalla de login pese a `storageState`. Si ves
un `[preflight]`, **arréglalo antes de seguir** (usa el MISMO host que tu app).

## Modo "app real" (apuntar a tu app y hacerla determinista)

Apunta `url` a la app real y **fija solo lo no-determinista**, dejando el resto real.

**Auth (login una vez, reutilizar):** declara `storageState`; si el fichero falta, los
`login.steps` se ejecutan una vez (headed) y la sesión (cookies+localStorage) se guarda
y reutiliza. Para regenerarla: `demo-recorder login mi-demo.yml`. Para MFA manual, el
login headed te deja completarlo a mano. `auth*.json` debe ir en `.gitignore` — nunca lo
subas. Credenciales por `${ENV}` (p.ej. PowerShell: `$env:DEMO_PASSWORD="…"`).

```yaml
url: ${APP_URL}
storageState: auth.json
login:
  url: ${APP_URL}/login
  steps:
    - type: { sel: 'input[type=email]', text: '${DEMO_EMAIL}' }
    - type: { sel: 'input[type=password]', text: '${DEMO_PASSWORD}' }
    - click: { sel: 'button[type=submit]', nav: true }
    - waitFor: '.dashboard'
```

**Interceptación selectiva (`route`):** reglas en orden, primera que casa gana. `url` es
glob (`*`) o substring. Lo que no casa va al backend real.

```yaml
route:
  - url: '**/api/dashboard*'      # fija un JSON a datos canned (lo más común)
    json: { data: { ... } }
  - url: '**/analytics/**'        # bloquea ruido (telemetría/ads)
    abort: true
  - url: '**/chat/stream'         # streaming: route.fulfill NO streamea; redirige a un
    redirect: http://127.0.0.1:4317/chat/stream   # mock SSE local (mismo protocolo)
  # también: { body, contentType, status } | { file, contentType }
```

Para SSE en https, `redirect` exige mismo protocolo (sirve en dev http); si no, apunta
toda la app a un staging/mock.

## Idle-speedup (quitar tiempos muertos)

Acelera los tramos sin acción (los `hold`) y deja la acción a 1x. El recorder anota los
holds en `<video>.idle.json`; el encode reencoda con `setpts` por segmentos. Los `hold`
se aceleran pero nunca por debajo de `floor`, y los menores de `minIdle` se dejan.

```yaml
encode:
  idleMp4: out/demo-fast.mp4
  idleOpts: { speed: 4, minIdle: 0.7, floor: 0.5 }   # todos opcionales
```

Mete tus pausas con `hold` (no con `waitFor` largos) para que el speedup sepa qué
comprimir. El streaming debe ocurrir bajo `waitFor` (acción), no en un `hold`.

## Captions / subtítulos (estilizados)

Las captions son eventos del timeline: cada `caption: '…'` se muestra hasta la siguiente
(una vacía la quita). `captionsMp4` los quema con libass; `srt` escribe el `.srt` aparte.

Por defecto el estilo es **"trazo limpio"**: texto blanco con **trazo/borde oscuro** (sin caja
negra), sombra suave y fade-in/out. Todo se ajusta con `captionsOpts.style` como **objeto**
(genera un `.ass`); pasar un **string** mantiene el modo legacy `force_style`.

```yaml
encode:
  srt: out/demo.srt                  # opcional: el .srt como pista aparte
  captionsMp4: out/work/demo-cc.mp4  # intermedio si encadenas voz → out/work/
  captionsOpts:
    style:
      font: Segoe UI
      fontSize: 24
      color: '#FFFFFF'
      outlineColor: '#101010'   # el TRAZO
      outline: 2                # grosor del trazo (px)
      shadow: 0.5
      marginV: 48
      fadeIn: 200               # ms
      fadeOut: 200              # ms
      # bold: true · alignment: 8 (arriba) · slideUp: 24 (entrada ease) · fontFile: <ttf no instalada>
```

Limitación: los tiempos son del clip **original**. Quema sobre el webm crudo, **no**
sobre un `idleMp4` (el speedup cambia la línea de tiempo y desincroniza).

## Elegir pistas (las 4 combinaciones)

Se combinan claves de `encode` (no hay clave de "modo"). Los `caption:` siempre graban sus
tiempos; que se **oigan** (voz) o se **vean** (subs) depende de qué actives:

| Modo | Claves |
|------|--------|
| Solo vídeo | `mp4` (o `idleMp4`) |
| Vídeo + audio (SIN subs) | `narrateMp4` + `ttsOpts`, **sin** `captionsMp4` (los caption dan voz, no se queman) |
| Vídeo + subs | `captionsMp4` (+ `captionsOpts`) |
| Vídeo + audio + subs | `captionsMp4` + `narrateMp4` |

## Voiceover (TTS)

Voz en español por cada caption, mezclada en su timestamp. Usa `edge-tts` (Microsoft,
gratis, sin API key) con caché por hash en `.cache/tts` → re-render offline y gratis. Si
`narrateMp4` ve un `captionsMp4` en el mismo run, narra encima → **voz + subtítulos**.

```yaml
encode:
  captionsMp4: out/work/demo-cc.mp4   # intermedio → out/work/
  narrateMp4: out/demo-voice.mp4      # FINAL
  ttsOpts:
    voice: es-ES-ElviraNeural   # o es-ES-AlvaroNeural, es-MX-DaliaNeural, es-MX-JorgeNeural…
    # provider: openai          # alt: endpoint OpenAI-compatible (Chatterbox local / OpenAI)
    # baseUrl: http://127.0.0.1:8004
```

**Deja holds suficientes** para que quepa la narración; si una se pasa, el log avisa con
cuánto subir ese hold (re-render instantáneo: la voz está cacheada). edge-tts usa un
endpoint no documentado de MS: si deja de funcionar, itera o cambia a `openai`/Chatterbox.

## Música de fondo con ducking

Cama musical bajo la voz, en `ttsOpts.music`. Se aplica como **capa final continua** sobre
todo el vídeo: si hay intro, la música **empieza con la intro** (a volumen alto) y baja antes
del primer TTS, sube en huecos largos y vuelve a subir tras el último.

**El motor incluye 3 pistas con licencia libre** (no necesitas tener audio en el proyecto). En
`track` pon un **alias** (`ambient-gold`, `sidewalk-chalk`, `she-said-i-wonder`), el nombre del
archivo, o una **ruta** a tu propio audio. Si omites `track` usa la *ambient* por defecto;
`music: true` = default + ducking por defecto. Lista las pistas con `demo-recorder tracks`.

```yaml
encode:
  narrateMp4: out/demo.mp4
  ttsOpts:
    voice: es-ES-ElviraNeural
    music:
      track: ambient-gold   # alias bundled · o sidewalk-chalk / she-said-i-wonder · o ruta propia
      full: 0.85       # volumen alto (huecos, antes y después)
      duck: 0.16       # volumen bajo (durante la voz)
      lead: 1.2        # s: baja ANTES de cada TTS
      tail: 0.8        # s: tarda en subir tras cada TTS
      gapRaise: 3.0    # s: hueco mínimo entre TTS para volver a 'full'
      fadeIn: 1.0      # s ·  fadeOut: 1.5
```

Sin captions, `music` da una cama plana a `full` con fades (vídeo + música, sin voz).

## Intro de marca (logo + título + animación)

`encode.intro` antepone una intro al mp4 final. La música (si la hay) la cubre de forma
continua. Dos motores: `ffmpeg` (tarjeta compuesta, rápida) o `html` (plantilla CSS grabada).

```yaml
encode:
  narrateMp4: out/demo.mp4
  intro:
    engine: ffmpeg            # ffmpeg | html
    prependTo: out/demo.mp4   # mp4 al que se antepone (def: el último producido)
    result: out/demo-intro.mp4   # FINAL
    duration: 2.8
    logo: assets/logo.png     # PNG con transparencia (opcional)
    title: 'Mi Web App'
    subtitle: 'tu eslogan'    # opcional
    bg: '#0B0F1A'
    animation: fade-zoom      # fade | fade-zoom
```

El clip de intro se genera en `out/work/` y se concatena (re-encode robusto); el resultado
queda en `result`. Ver `docs/MEJORAS_ESTETICAS.md` del motor para todos los detalles.

## Otros gotchas

- **Streaming "de golpe"**: `route.fulfill` entrega el body de una vez → para SSE usa un
  mock con `sleep` entre chunks y `redirect` hacia él.
- **Duración del webm engañosa**: el header del webm de Playwright miente; `frames` mide
  la duración real decodificando. No te fíes del header si extraes a mano.
- **Vídeo borroso**: `scale` ≥ 2. **Zoom recorta**: usa `zoomFit` o baja la escala.
- **`chromium.launch` "Executable doesn't exist"**: `npx playwright install chromium`.

## Publicar

- **README de GitHub**: arrastra el `.webm` al editor (inline, límite 10 MB; ~30 s ≈ 2–3 MB).
- **Compatibilidad / con voz**: usa el `.mp4` (H.264). **Highlight**: un `.gif` corto.

## Referencia CLI

```
demo-recorder probe  <guion.yml> [--from N --to M]   dry-run headed, para en el 1º fallo + vuelca DOM (úsalo PRIMERO)
demo-recorder record <guion.yml> [--from N --to M]   solo grabar (rápido, sin encode) — iterar timing/zoom
demo-recorder encode <guion.yml> [webm]              solo encode (voz/subtítulos/mp4) sobre el último webm
demo-recorder run    <guion.yml> [--no-encode]       record + encode (toma final)
demo-recorder frames <video> [t1,t2,..] [out.png]    contact-sheet con timestamps (→ out/frames/)
demo-recorder clean  [--all] [--keep N]              ordena out/: borra intermedios/temps, poda raw/ (deja finales)
demo-recorder tracks                                 lista la música de fondo incluida (audio/bg/) y sus alias
demo-recorder login  <guion.yml>                     (re)genera storageState
demo-recorder mock                                   app demo de ejemplo (127.0.0.1:4317)
```

Flags: `--from N`/`--to M` ejecutan solo un sub-rango de pasos (1-based, inclusive) para
afinar UN beat sin re-reproducir los anteriores. Si ese beat depende de estado previo,
combínalo con `route` (mocks instantáneos) o un `goto` al inicio del rango.
