# emf-badge-map

Raster map tiles for the [EMF Camp](https://www.emfcamp.org/) site, rendered for display on a badge with a 240×240 round screen.

Tiles are served via [GitHub Pages](https://futureshape.github.io/emf-badge-map/) as standard `{z}/{x}/{y}.png` files in the [Slippy Map](https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames) layout.

## Tile specification

| Property | Value |
|---|---|
| Format | PNG |
| Size | 256×256 px |
| Zoom levels | 14 – 20 |
| Bounding box | 52.03763°N–52.04421°N, 2.37295°W–2.38038°W |
| Projection | Web Mercator (EPSG:3857) |

## Rendering pipeline

Vector tiles are fetched from the [EMF map server](https://map.emfcamp.org/) and rendered offline using [MapLibre GL Native](https://github.com/maplibre/maplibre-native) (Node.js).

```
map.emfcamp.org  ──►  render_tiles.js  ──►  tiles/{z}/{x}/{y}.png
 (vector PBF)         (MapLibre Native)       (raster PNG 256px)
```

Key details:

- **Source tiles** are gzip-compressed PBF served from `map.emfcamp.org/maps/buildmap/{z}/{x}/{y}.pbf`. The renderer decompresses them before passing to MapLibre Native.
- **Render resolution**: MapLibre Native's internal tile size is 512px. The renderer requests 512×512 and downscales to 256×256 via [sharp](https://sharp.pixelplumbing.com/) to ensure correct geographic alignment at tile boundaries. Text sizes in the style are doubled to compensate.
- **Zoom 20** is the maximum zoom of the source data; rendering beyond this would show no additional detail.

### Running the renderer

```bash
npm install
node render_tiles.js
```

Options:

```
--min-zoom  N    Minimum zoom level to render (default: 14)
--max-zoom  N    Maximum zoom level to render (default: 20)
--output    DIR  Output directory (default: tiles)
```

Example — render only zoom 18–20:

```bash
node render_tiles.js --min-zoom 18 --max-zoom 20
```

## Viewer

Open `badge-viewer.html` (served via any HTTP server, or from the GitHub Pages URL) to browse the rendered tiles in a 240px round badge preview.

| Key | Action |
|---|---|
| Arrow keys | Pan by half a tile |
| `+` / `-` | Zoom in / out |

```bash
python -m http.server 8000
# open http://localhost:8000/badge-viewer.html
```

## Deployment

Pushing to `main` automatically deploys the viewer and tiles to GitHub Pages via the workflow in `.github/workflows/deploy.yml`. Enable it once in **Settings → Pages → Source: GitHub Actions**.
