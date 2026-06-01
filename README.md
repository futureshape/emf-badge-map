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

- **Source tiles** are vector PBF served from `map.emfcamp.org/tiles/_main/{z}/{x}/{y}`. The renderer still handles gzip-compressed responses when present.
- **Style parity**: rendering uses `web-map-style.json`, generated from `emfcamp/map` web style sources (`web/src/style/map_style.ts` + `web/src/style/basemap.ts`) so tile styling matches the live map schema.
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

### Optimising tile file size

After rendering, compress tiles with `pngquant` to reduce file size by ~80–85%.

```bash
brew install pngquant   # macOS; skip if already installed
./compress_tiles.sh
```

The script compresses all tiles in `tiles/` in place using `--quality=65-90`, prints per-tile savings, and summarises total size reduction. It is safe to re-run — tiles that would grow are skipped automatically.

To compress a different directory:

```bash
./compress_tiles.sh path/to/tiles
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

## Tildagon badge app

`app/` contains a [Tildagon](https://tildagon.badge.emfcamp.org/) badge app that fetches and displays the map tiles on the badge's 240×240 round screen.

### Controls

| Button | Action |
|---|---|
| Up / Down / Left / Right | Pan the map by one tile |
| Confirm | Zoom in |
| Cancel | Zoom out (at minimum zoom, exits the app) |

### How it works

- On startup the app connects to Wi-Fi and clears any locally cached tiles.
- When you navigate, a "Loading..." overlay is shown on top of the current tile while the next one is fetched over HTTPS from GitHub Pages.
- Tiles are cached to the app's `/cache/` folder on the badge filesystem. Up to 20 tiles are kept; older ones are evicted automatically.
- The display uses `ctx.image()` to render the 256×256 PNG tile centred on the 240px round screen.

### Installing on the badge

Copy the app to your badge using `mpremote`:

```bash
mpremote mkdir :apps/emf_map
mpremote cp app/app.py :apps/emf_map/app.py
mpremote cp app/tildagon.toml :apps/emf_map/tildagon.toml
```

Then reboot the badge. The app will appear in the launcher as **EMF Map**.
