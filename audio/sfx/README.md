# audio/sfx/ — efectos de sonido para `encode.sfx`

Suelta aquí ficheros de audio cortos (`.wav`/`.mp3`/`.m4a`/…) y el motor los sincroniza con los
**beats** de la grabación (clicks, zooms, teclas) usando el sidecar `<video>.events.json`.

La resolución funciona igual que la música (`audio/bg/`): por nombre exacto, por alias/slug o por
ruta. Los SFX son **opcionales** — si un nombre no se resuelve, ese efecto simplemente se omite
(no rompe el render).

## Nombres por defecto (mapa kind → SFX)

| evento (`kind`) | SFX por defecto |
|---|---|
| `click`, `nav`   | `click` |
| `zoom`            | `whoosh` |
| `keycap`         | `key` |
| `success`        | `chime` |
| `type`, `move`, `scroll`, `spotlight`, `zoomOut` | (silenciados) |

> `zoomOut` y `spotlight` van silenciados para que **un gesto suene una vez**: el zoom-*in* ya hace
> `whoosh` (un segundo en el reset se oiría doble), y el spotlight acompaña a su `zoomFit`. Mapéalos
> si los quieres: `map: { zoomOut: whoosh }`. Los SFX suenan a un **gain conservador por defecto**
> (los clips son fuertes); súbelo con `sfx.gain`. Un cooldown por sonido evita dobles.

Así que basta con dejar aquí `click.wav`, `whoosh.wav`, `key.wav`, `chime.wav` (o alias que
contengan esas palabras) para tener SFX. Sobrescribe el mapa desde el `.yml`:

```yaml
encode:
  sfx:
    gain: 0.8                 # ganancia global (0..1+)
    map:
      click: pop              # usa audio/sfx/pop.wav para los clicks
      zoom: { name: swoosh, gain: 0.5 }
      nav: null               # silencia un kind
    # dir: assets/my-sfx      # opcional: carpeta propia en tu proyecto
```

El motor ya incluye 4 SFX (`click.wav`, `whoosh.wav`, `key.wav`, `chime.wav`), así que los SFX
funcionan de fábrica. Sobrescríbelos con los tuyos (mismos nombres) o apunta `dir` a tu propia
carpeta. Usa audio libre de derechos.
