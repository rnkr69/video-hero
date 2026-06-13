# Guía de uso — demo-recorder

Cómo grabar un vídeo hero/demo **fluido y determinista** de una web app. Pensada para
Windows (PowerShell). El flujo de trabajo es siempre el mismo bucle:

> **escribir guión → grabar → sacar contact-sheet → mirarlo → ajustar → encodear**

Índice:
1. [Requisitos (una vez)](#1-requisitos-una-vez)
2. [Arranque rápido con la demo](#2-arranque-rápido-con-la-demo-verifica-tu-instalación)
3. [El esquema del guión (YAML)](#3-el-esquema-del-guión-yaml)
4. [Grabar tu web real, paso a paso](#4-grabar-tu-web-real-paso-a-paso)
5. [Hacer la app determinista (modo app real)](#5-hacer-la-app-determinista-modo-app-real)
6. [Login / sesión](#6-login--sesión)
7. [Encodear: subtítulos, voz, acelerar, mp4/gif](#7-encodear-subtítulos-voz-acelerar-mp4gif)
8. [El bucle de auto-verificación](#8-el-bucle-de-auto-verificación-clave)
9. [Publicar](#9-publicar)
10. [Problemas frecuentes](#10-problemas-frecuentes)
11. [Usarlo desde Claude Code](#11-usarlo-desde-claude-code)

---

## 1. Requisitos (una vez)

```powershell
cd C:\wamp64_337\www\video_hero
npm install
npm link        # registra el comando global `demo-recorder` (para usarlo desde otros proyectos)
# El navegador de Chromium ya está cacheado. Si falla por revisión:
npx playwright install chromium
```

- **Node 20+** (tienes 24).
- **ffmpeg** se instala solo vía `ffmpeg-static` (no hace falta instalar nada del sistema).
- **No necesita API keys**: la voz usa `edge-tts` (gratis).

> **Dos formas de invocarlo (equivalentes):**
> - **CLI global** (recomendada, funciona desde cualquier carpeta): `demo-recorder run mi.yml`
> - **Local** (dentro de video_hero): `node src/run.js mi.yml`
>
> En esta guía verás `node src/...`; sustituye por `demo-recorder ...` si usas la CLI.

### Usar desde OTRO proyecto (lo habitual)

El motor se instala una sola vez (aquí). Desde el proyecto de tu web —donde Claude Code
conoce la app— escribes el `.yml` y lo lanzas con la CLI global; **las salidas caen en
ese proyecto**:

```powershell
cd C:\ruta\a\tu-proyecto-web
demo-recorder probe  .\mi-demo.yml       # 1) valida selectores/auth (headed, ~10s, sin grabar)
demo-recorder record .\mi-demo.yml       # 2) graba sin encode -> demo-out\page@<hash>.webm
demo-recorder frames .\demo-out\page@<hash>.webm   #    contact-sheet para revisar
demo-recorder encode .\mi-demo.yml       # 3) voz/subtítulos/mp4 una sola vez al final
```

Comandos: `demo-recorder probe|record|encode|run|frames|login|mock|help`. Hay un **skill
global** (`demo-video-hero`) en todos tus proyectos: pídele a Claude Code que grabe el
vídeo y él escribe el `.yml`, lo prueba con `probe`, graba, mira el contact-sheet y ajusta.

---

## 2. Arranque rápido con la demo (verifica tu instalación)

Antes de tu web real, comprueba que todo el pipeline funciona con la app de ejemplo:

```powershell
# Terminal 1: backend + app demo
npm run mock
# Terminal 2: grabar el guión de ejemplo
node src/run.js examples/demo.yml
# -> imprime  VIDEO: out\page@<hash>.webm
```

Saca un contact-sheet y míralo:

```powershell
node scripts/frames.mjs out\page@<hash>.webm
# abre out\contact.png  (cada frame lleva su timestamp)
```

Si ves cursor, tecleo, tabla y zoom → todo OK. Otros ejemplos para probar las capas:
`examples/autozoom.yml` (auto-zoom + acelerar), `examples/captions.yml` (subtítulos),
`examples/narrate.yml` (voz + subtítulos).

---

## 3. El esquema del guión (YAML)

Un guión es un `.yml` con configuración + una lista de `steps`. Mínimo:

```yaml
url: http://localhost:3000      # tu app
width: 1280                     # opcional (def 1280)
height: 800                     # opcional (def 800)
scale: 2                        # opcional, nitidez HiDPI (def 2)
headless: true                  # opcional (def true)
out: out                        # opcional, carpeta de salida

steps:
  - hold: 800                                   # esperar ms
  - type: { sel: '#search', text: 'hola', cps: 38 }   # teclear char-a-char
  - click: '#submit'                            # click con cursor + pulse
  - click: { sel: 'nav a.report', nav: true }   # click que NAVEGA de página
  - move: '#kpi'                                # mover el cursor a un elemento
  - waitFor: '.results'                         # esperar a que aparezca (Playwright)
  - zoomFit: '.results'                         # AUTO-ZOOM al bounding box
  - zoomTo: { sel: '#chart', scale: 1.3 }       # zoom manual (escala fija)
  - resetZoom: true                             # volver a 1x
  - caption: 'Texto en pantalla'                # subtítulo desde aquí…
  - caption: ''                                 #   …vacío = quitarlo
```

**Selectores — regla importante (dos sintaxis):**
- En `type/click/move/zoomTo/zoomFit` (van por la capa inyectada) usa `host >>> inner`
  para atravesar **shadow DOM** (web components). Ej: `mi-widget >>> textarea`.
- En `waitFor` (va por Playwright) usa **CSS normal**; Playwright atraviesa shadow roots
  abiertos solo. Ej: `mi-widget table`.

---

## 4. Grabar tu web real, paso a paso

1. **Arranca tu app** en una URL local (o usa su URL desplegada).
2. **Copia un ejemplo** como punto de partida:
   ```powershell
   copy examples\demo.yml examples\mi-demo.yml
   ```
3. **Edita `mi-demo.yml`**: pon tu `url` y reescribe los `steps` con tus selectores y el
   flujo. (Para encontrar selectores: abre tu app → clic derecho → Inspeccionar.)
4. **PROBE** (valida selectores/auth en ~10 s, sin grabar; para en el 1º que falla y
   vuelca el DOM):
   ```powershell
   demo-recorder probe mi-demo.yml          # afina UN beat con  --from N --to M
   ```
5. **RECORD** (solo grabar, rápido) + mira el contact-sheet, y **ajusta** timing/zoom:
   ```powershell
   demo-recorder record mi-demo.yml
   demo-recorder frames demo-out\page@<hash>.webm
   ```
   Repite 5 hasta que quede fluido (no encodees aún: el TTS/subtítulos tardan 30–60 s).
6. **ENCODE** una sola vez al final (voz/subtítulos/mp4, sección 7):
   ```powershell
   demo-recorder encode mi-demo.yml
   ```

> Si tu app responde **siempre igual** (estática o datos fijos) → con esto basta.
> Si tiene datos dinámicos, LLM, streaming, hora actual, etc. → sigue en la sección 5.

---

## 5. Hacer la app determinista (modo app real)

Para que el guión sea **repetible**, fija SOLO lo no-determinista y deja el resto real,
con reglas `route` (se prueban en orden, la primera que casa gana):

```yaml
url: https://mi-app.com
route:
  # 1) Fijar un endpoint JSON a datos canned (lo más común):
  - url: '**/api/dashboard*'
    json: { data: { kpis: [ ... ], chart: { ... } } }

  # 2) Bloquear ruido (analítica, ads, websockets de telemetría):
  - url: '**/analytics/**'
    abort: true

  # 3) Streaming SSE (chat LLM): route.fulfill NO streamea (entrega de golpe), así que
  #    redirige a un mock SSE local que emite con pausas (mismo protocolo; sirve en http):
  - url: '**/chat/stream'
    redirect: http://127.0.0.1:4317/chat/stream
```

`url` admite glob (`*`) o substring. Acciones por regla: `json`, `body`+`contentType`,
`file`, `redirect`/`mock`, `abort`. Lo que no casa ninguna regla va al backend real.

> Para el SSE de un chat LLM, lo más fiable es levantar el `mock-server` (adáptalo a tus
> endpoints, ver `examples/mock-server.mjs`) y `redirect` la ruta de streaming hacia él.

### Apps con chat / streaming (LLM) — patrón universal

- **Sube `waitTimeout: 45000`** en la raíz del guión: el default de 20 s es corto para LLMs.
- **Antes de enviar el siguiente mensaje, espera a que el botón de enviar se RE-HABILITE**
  (señal fiable de "terminó de streamear"), no solo a que aparezca texto:
  ```yaml
  - waitFor: 'button.send:not([disabled])'
  ```
  Otras señales: desaparición del cursor de streaming, o aparición del bloque final.

### Preflight (te avisa de las trampas)

`probe`/`record`/`run` avisan si `url` no casa con `$APP_URL` (la clásica trampa
**127.0.0.1 ↔ localhost** que rompe cookies/CSRF en Laravel y similares), o si acabas en
otro host / en login pese a `storageState`. Si ves `[preflight]`, usa el **mismo host** que
tu app antes de seguir.

---

## 6. Login / sesión

Si tu app requiere autenticación, haz login **una vez** y reutiliza la sesión.

**Opción A — desde el YAML** (login scriptable). Declara `storageState`; si el fichero no
existe, los `login.steps` se ejecutan una vez y la sesión se guarda y reutiliza:

```powershell
$env:DEMO_EMAIL="yo@correo.com"; $env:DEMO_PASSWORD="secreto"
```
```yaml
storageState: auth.json
login:
  url: https://mi-app.com/login
  steps:
    - type: { sel: 'input[type=email]', text: '${DEMO_EMAIL}' }
    - type: { sel: 'input[type=password]', text: '${DEMO_PASSWORD}' }
    - click: { sel: 'button[type=submit]', nav: true }
    - waitFor: '.dashboard'
```

**Opción B — manual (para MFA/captcha):** edita `scripts/login.mjs` con tu URL/selectores
y ejecútalo; se abre el navegador (headed) para que completes lo que haga falta:

```powershell
node scripts/login.mjs    # guarda auth.json
```

Notas:
- `${VAR}` se sustituye desde el entorno → **nunca** pongas contraseñas en el YAML.
- `auth*.json` está en `.gitignore` (contiene tu sesión: no lo subas).
- Para regenerar la sesión, borra `auth.json` y vuelve a grabar.

Plantilla completa de app real con login + route: **`examples/real-app.yml`**.

---

## 7. Encodear: subtítulos, voz, acelerar, mp4/gif

Añade un bloque `encode:` al final del guión. Todo es opcional y se aplica tras grabar:

```yaml
encode:
  srt: out/demo.srt              # escribe el fichero de subtítulos (.srt)
  captionsMp4: out/demo-cc.mp4   # quema los subtítulos en un mp4
  narrateMp4: out/demo-voice.mp4 # voz TTS (si hay captionsMp4, sale voz + subtítulos)
  ttsOpts:
    voice: es-ES-ElviraNeural    # o es-ES-AlvaroNeural, es-MX-DaliaNeural, es-MX-JorgeNeural…
  idleMp4: out/demo-fast.mp4     # acelera los tiempos muertos (los `hold`)
  idleOpts: { speed: 4 }
  mp4: out/demo.mp4              # mp4 H.264 “a pelo”
  gif: out/demo.gif              # gif corto de highlight
```

Claves:
- **Subtítulos/voz** se sincronizan con tus `caption`. **Deja `hold` suficientes** para
  que quepa la narración; si una se pasa, el log te avisa con cuánto subir ese hold
  (la voz se cachea en `.cache/tts`, así que re-renderizar es instantáneo).
- **No combines** subtítulos/voz con `idleMp4`: el acelerado cambia la línea de tiempo y
  desincroniza. Saca por un lado el vídeo con voz/subtítulos y por otro el acelerado.

### Mejoras estéticas (subs con trazo, intro, música)

Cuatro extras se documentan en detalle en **[docs/MEJORAS_ESTETICAS.md](MEJORAS_ESTETICAS.md)**:

- **Elegir pistas** — las 4 combinaciones (solo vídeo / +audio / +subs / +ambos). Para
  **audio sin subs**, usa `narrateMp4` sin `captionsMp4` (ejemplo `examples/voice-only.yml`).
- **Subtítulos estilizados** — `captionsOpts.style` (objeto) genera un `.ass`: trazo en vez de
  caja negra, fuente/color/grosor configurables y fade-in/out. Ejemplo `examples/styled-subs.yml`.
- **Intro de marca** — `encode.intro` antepone una tarjeta con logo + título + animación
  (motor `ffmpeg` o `html`).
- **Música de fondo con ducking** — `ttsOpts.music` baja la música antes del primer TTS, la
  sube en huecos largos y la devuelve al final. **3 pistas incluidas** (alias `ambient-gold`,
  `sidewalk-chalk`, `she-said-i-wonder`; `demo-recorder tracks`) o tu propio audio. Ejemplo `examples/intro-music.yml`.

```yaml
encode:
  captionsMp4: out/demo-cc.mp4
  captionsOpts: { style: { outlineColor: '#101010', outline: 2, fadeIn: 200, fadeOut: 200 } }
  narrateMp4: out/demo.mp4
  ttsOpts:
    voice: es-ES-ElviraNeural
    music: { track: ambient-gold, full: 0.85, duck: 0.16, lead: 1.2, gapRaise: 3.0 }  # pista incluida (alias)
  intro: { engine: ffmpeg, title: 'Mi Web App', logo: assets/logo.png, result: out/demo-intro.mp4 }
```

---

## 8. El bucle de auto-verificación (clave)

No hace falta ver el vídeo en directo. Tras cada grabación (`record`):

```powershell
demo-recorder frames demo-out\page@<hash>.webm
```

Genera el contact-sheet en `out/frames/` (una rejilla de frames **con el timestamp de cada
uno**). Ábrelo y comprueba cursor, tecleo, render del contenido y encuadre del zoom. Si algo
falla, sabes el segundo exacto → ajusta el `hold`/`zoom`/selector y regraba con `record`.

Frames en momentos concretos:
```powershell
demo-recorder frames out\raw\page@<hash>.webm "0.5,3,5,7,9"
```

> Para fallos de **selector o auth** (no de timing), usa `demo-recorder probe` en vez de
> grabar: es headed, para en el primer fallo y te vuelca el DOM. Mucho más rápido.

---

## 8.1 La carpeta out/ (organización y limpieza)

`out/` se mantiene ordenada para que el **vídeo final** sea fácil de encontrar:

```
out/
├── mi-demo.mp4         ← FINALES (lo que publicas) — sueltos en la raíz
├── raw/                ← grabaciones page@<hash>.webm (+ .json). Se conservan las 3 últimas
├── frames/             ← contact-sheets de revisión (sin tiles sueltos)
└── work/               ← intermedios (-cc.mp4, intro, .ass, temporales) — se autolimpian
```

- Tras cada `run` se **podan** las grabaciones antiguas de `raw/` (se quedan las 3 más
  recientes, configurable con `keepRaw:` en el guión) para poder re-encodear sin acumular gigas.
- Los **intermedios** (subtítulos `-cc`, clip de intro, `.ass`, temporales `.novol`/`.mtmp`) van
  a `out/work/` y se borran solos al terminar.
- Purga a demanda con **`demo-recorder clean`**: borra ruido (tiles, contact-sheets, `_scratch`,
  intermedios) y poda `raw/`, **sin tocar los finales**. `--all` vacía además `raw/` y `frames/`;
  `--keep N` cambia cuántas grabaciones conservar.

```powershell
demo-recorder clean              # limpieza normal (deja finales + 3 grabaciones)
demo-recorder clean --all        # purga profunda (solo finales)
demo-recorder clean --keep 1     # conserva solo la última grabación
```

---

## 9. Publicar

- **README de GitHub (lo más simple):** arrastra el `.webm` al editor del README (GitHub
  lo hostea y reproduce inline; límite 10 MB, ~30 s rondan 2–3 MB). No hace falta encodear.
- **Máxima compatibilidad / con voz:** usa el `.mp4` (H.264) — p.ej. `out/demo-voice.mp4`.
- **Highlight ligero:** un `.gif` corto.

---

## 10. Problemas frecuentes

| Síntoma | Causa | Solución |
|---|---|---|
| El streaming aparece “de golpe” | `route.fulfill` no streamea | mock SSE con pausas + `redirect` (sección 5) |
| `chromium.launch` “Executable doesn't exist” | revisión de navegador desfasada | `npx playwright install chromium` |
| No encuentra el elemento de un widget | está en shadow DOM | usa `host >>> inner` en type/click/zoom |
| `waitFor` no lo encuentra pero el click sí (o al revés) | dos sintaxis de selector | `waitFor` = CSS Playwright; resto = `>>>` |
| Vídeo borroso | sin HiDPI | `scale: 2` (o más) |
| El zoom recorta contenido | escala alta cerca de un borde | usa `zoomFit` (auto) o baja `scale` |
| La narración se solapa con la fase siguiente | `hold` corto | sube ese `hold` (el log te dice cuánto) |
| Frames vacíos al final del contact-sheet | timestamp más allá del clip | el clip es más corto; usa timestamps válidos |
| La voz dejó de generarse | edge-tts usa un endpoint no oficial de MS | reintenta; si persiste, usa el proveedor `openai`/Chatterbox |
| `waitFor` agota el tiempo en un chat LLM | 20 s es poco para streaming | `waitTimeout: 45000` y espera `button:not([disabled])` |
| Aviso `[preflight]` 127.0.0.1↔localhost | host de `url` ≠ el de tu app | usa el MISMO host (cookies/CSRF) |
| Cuesta dar con el selector correcto | iteras grabando (lento) | `demo-recorder probe` headed: para en el fallo y vuelca el DOM |

---

## 11. Usarlo desde Claude Code

Hay un **skill** (`demo-video-hero`) que enseña a Claude Code a generar y afinar guiones
por ti. Basta con pedirle algo como:

> “Tengo la app en `http://localhost:3000`. Quiero un vídeo que abra el panel, busque X,
> muestre el resultado con zoom y vaya al informe. Usa demo-recorder.”

Claude Code escribirá el `.yml`, grabará, sacará el contact-sheet, lo mirará y ajustará
hasta que quede fluido — el bucle de la sección 8, automatizado.
