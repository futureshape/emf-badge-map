#!/usr/bin/env node
/**
 * Render EMF map vector tiles as raster PNGs using MapLibre Native.
 *
 * Usage: node render_tiles.js [--min-zoom 14] [--max-zoom 19] [--output tiles]
 */

const mbgl = require("@maplibre/maplibre-gl-native");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const zlib = require("zlib");

// --- Config ---
const TILE_SIZE = 256;
const RENDER_SIZE = 512; // MapLibre uses 512px internal tile size
const DEFAULT_BBOX = {
  west: -2.38038,
  south: 52.03763,
  east: -2.37295,
  north: 52.04421,
};
const DEFAULT_MIN_ZOOM = 14;
const DEFAULT_MAX_ZOOM = 20;

// --- Tile math ---
function lngToTileX(lng, zoom) {
  return Math.floor(((lng + 180) / 360) * (1 << zoom));
}
function latToTileY(lat, zoom) {
  const latRad = (lat * Math.PI) / 180;
  const n = 1 << zoom;
  return Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
      n
  );
}
function tileToBBox(x, y, z) {
  const n = 1 << z;
  return {
    west: (x / n) * 360 - 180,
    east: ((x + 1) / n) * 360 - 180,
    north:
      (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI,
    south:
      (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) /
      Math.PI,
  };
}

function getTileRanges(bbox, minZoom, maxZoom) {
  const tiles = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const xMin = lngToTileX(bbox.west, z);
    const xMax = lngToTileX(bbox.east, z);
    const yMin = latToTileY(bbox.north, z);
    const yMax = latToTileY(bbox.south, z);
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        tiles.push({ z, x, y });
      }
    }
  }
  return tiles;
}

// --- Network fetcher ---
function fetchURL(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    mod
      .get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return fetchURL(res.headers.location).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          let buf = Buffer.concat(chunks);
          // Decompress gzip if needed (buildmap tiles are gzip-compressed)
          if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
            buf = zlib.gunzipSync(buf);
          }
          resolve(buf);
        });
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

// --- Style ---
const STYLE = {
  version: 8,
  name: "EMF",
  sources: {
    site_plan: {
      type: "vector",
      tiles: ["https://map.emfcamp.org/maps/buildmap/{z}/{x}/{y}.pbf"],
      minzoom: 7,
      maxzoom: 20,
    },
    villages: {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    },
  },
  glyphs: "https://map.emfcamp.org/fonts/{fontstack}/{range}.pbf",
  layers: [
    {
      id: "background",
      type: "background",
      paint: { "background-color": "#DBE8A5" },
    },
    {
      id: "bounding_box",
      type: "fill",
      source: "site_plan",
      "source-layer": "bounding_box",
      paint: { "fill-color": "#DBE8A5" },
    },
    {
      id: "background_areas_camping_polygon",
      type: "fill",
      source: "site_plan",
      "source-layer": "areas_camping_polygon",
      paint: { "fill-color": "#AFC944" },
    },
    {
      id: "background_areas_camping_outline",
      type: "line",
      source: "site_plan",
      "source-layer": "areas_camping_polygon",
      paint: {
        "line-color": "rgba(10, 100, 10, 0.4)",
        "line-blur": 7,
        "line-width": 3,
      },
    },
    {
      id: "background_natural_woodland_polygon",
      type: "fill",
      source: "site_plan",
      "source-layer": "natural_woodland_polygon",
      paint: { "fill-color": "#528329" },
    },
    {
      id: "background_natural_hedges_polygon",
      type: "fill",
      source: "site_plan",
      "source-layer": "natural_hedges_polygon",
      paint: { "fill-color": "#528329" },
    },
    {
      id: "background_water_linestring",
      type: "line",
      source: "site_plan",
      "source-layer": "natural_water_linestring",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#2EADD9",
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          13, 1, 15, 2, 18, 6,
        ],
      },
    },
    {
      id: "background_water_polygon_shadow",
      type: "line",
      source: "site_plan",
      "source-layer": "natural_water_polygon",
      paint: {
        "line-color": "#1D718C",
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          13, 0, 18, 2,
        ],
      },
    },
    {
      id: "paths_tracks_case",
      type: "line",
      source: "site_plan",
      "source-layer": "paths_roads_polygon",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          12, 0, 17, 5,
        ],
        "line-color": "rgba(132, 131, 131, 1)",
        "line-blur": 0.5,
      },
    },
    {
      id: "paths_trackway",
      type: "fill",
      source: "site_plan",
      "source-layer": "paths_trackway_polygon",
      paint: { "fill-color": "rgba(185, 185, 185, 1)" },
    },
    {
      id: "paths_tracks",
      type: "fill",
      source: "site_plan",
      "source-layer": "paths_roads_polygon",
      paint: {
        "fill-color": "rgba(177, 165, 147, 1)",
        "fill-outline-color": "rgba(98, 98, 97, 0)",
      },
    },
    {
      id: "structures_shadow",
      type: "line",
      source: "site_plan",
      "source-layer": "structures_polygon",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "rgba(0, 0, 0, 0.3)",
        "line-width": 6,
        "line-blur": 3,
      },
    },
    {
      id: "structures_polygon",
      type: "fill",
      source: "site_plan",
      "source-layer": "structures_polygon",
      paint: { "fill-color": "#F9E200" },
    },
    {
      id: "structures_outline",
      type: "line",
      source: "site_plan",
      "source-layer": "structures_polygon",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "rgba(90, 81, 31, 1)" },
    },
    {
      id: "structures_linestring",
      type: "line",
      source: "site_plan",
      "source-layer": "structures_linestring",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "rgba(90, 81, 31, 1)" },
    },
    {
      id: "boundary",
      type: "line",
      source: "site_plan",
      "source-layer": "heras_perimeter__linestring",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "rgba(226, 11, 11, 1)",
        "line-dasharray": [10, 3],
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          10, 1, 17, 2,
        ],
      },
    },
    {
      id: "villages_symbol",
      type: "circle",
      source: "villages",
      "source-layer": "",
      minzoom: 16,
      paint: {
        "circle-color": "rgb(246, 163, 24)",
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          16, 6, 24, 26,
        ],
        "circle-blur": 0.5,
        "circle-stroke-width": 0.5,
      },
    },
    {
      id: "villages_text",
      type: "symbol",
      source: "villages",
      "source-layer": "",
      minzoom: 17,
      maxzoom: 24,
      layout: {
        "text-field": "{name}",
        "text-font": ["Open Sans Regular"],
        "text-offset": [0, -1.8],
        "text-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          17, 22, 24, 32,
        ],
      },
      paint: {
        "text-halo-color": "rgba(244, 235, 247, 0.73)",
        "text-halo-width": 4,
        "text-halo-blur": 2,
      },
    },
    {
      id: "labels_streets",
      type: "symbol",
      source: "site_plan",
      "source-layer": "streets_linestring",
      minzoom: 16,
      layout: {
        "text-field": "{name}",
        "text-font": ["Open Sans Regular"],
        "text-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          16, 16, 17, 18, 23, 100,
        ],
        "text-max-angle": 10,
        "symbol-placement": "line",
        "symbol-spacing": 500,
      },
      paint: {
        "text-halo-color": "rgba(120, 120, 120, 1)",
        "text-halo-width": 30,
        "text-halo-blur": 80,
        "text-color": "rgba(250, 250, 250, 1)",
      },
    },
    {
      id: "labels_main_1",
      type: "symbol",
      filter: ["==", ["get", "priority"], "1"],
      source: "site_plan",
      "source-layer": "labels_point",
      minzoom: 15,
      maxzoom: 20,
      layout: {
        "text-field": "{text}",
        "text-font": ["Open Sans Regular"],
        "text-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          15, 20, 23, 80,
        ],
        "text-optional": false,
      },
      paint: {
        "text-halo-color": "rgba(241, 241, 241, 1)",
        "text-halo-width": 6,
        "text-halo-blur": 2,
        "text-color": "rgba(0, 0, 0, 1)",
      },
    },
    {
      id: "labels_main_2",
      type: "symbol",
      filter: ["==", ["get", "priority"], "2"],
      source: "site_plan",
      "source-layer": "labels_point",
      minzoom: 16,
      maxzoom: 21,
      layout: {
        "text-field": "{text}",
        "text-font": ["Open Sans Regular"],
        "text-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          16, 12, 23, 60,
        ],
        "text-optional": false,
      },
      paint: {
        "text-halo-color": "rgba(241, 241, 241, 1)",
        "text-halo-width": 6,
        "text-halo-blur": 2,
        "text-color": "rgba(0, 0, 0, 1)",
      },
    },
    {
      id: "labels_main_3",
      type: "symbol",
      filter: ["!", ["has", "priority"]],
      source: "site_plan",
      "source-layer": "labels_point",
      minzoom: 17.5,
      layout: {
        "text-field": "{text}",
        "text-font": ["Open Sans Regular"],
        "text-size": 26,
        "text-optional": false,
      },
      paint: {
        "text-halo-color": "rgba(241, 241, 241, 1)",
        "text-halo-width": 6,
        "text-halo-blur": 2,
        "text-color": "rgba(0, 0, 0, 1)",
      },
    },
  ],
};

// --- Render a single tile ---
function renderTile(map, z, x, y) {
  return new Promise((resolve, reject) => {
    const bb = tileToBBox(x, y, z);
    const centerLng = (bb.west + bb.east) / 2;
    const centerLat = (bb.south + bb.north) / 2;

    // Render at 512x512 (MapLibre's internal tile size) to cover exactly
    // one standard tile's geographic extent, then downscale to 256x256.
    map.render(
      {
        zoom: z,
        center: [centerLng, centerLat],
        width: RENDER_SIZE,
        height: RENDER_SIZE,
      },
      (err, buffer) => {
        if (err) return reject(err);
        resolve(buffer);
      }
    );
  });
}

// --- Main ---
async function main() {
  const args = process.argv.slice(2);
  let minZoom = DEFAULT_MIN_ZOOM;
  let maxZoom = DEFAULT_MAX_ZOOM;
  let outputDir = "tiles";

  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === "--min-zoom") minZoom = parseInt(args[i + 1]);
    if (args[i] === "--max-zoom") maxZoom = parseInt(args[i + 1]);
    if (args[i] === "--output") outputDir = args[i + 1];
  }

  const tiles = getTileRanges(DEFAULT_BBOX, minZoom, maxZoom);
  console.log(`Bounding box:`, DEFAULT_BBOX);
  console.log(`Zoom range: ${minZoom}-${maxZoom}`);
  console.log(`Total tiles: ${tiles.length}`);

  // Create the map instance with a request handler for remote resources
  const requestLog = [];
  const map = new mbgl.Map({
    request: (req, callback) => {
      requestLog.push(req.url);
      fetchURL(req.url)
        .then((data) => {
          callback(null, { data });
        })
        .catch((err) => {
          console.error(`  Fetch failed: ${req.url} - ${err.message}`);
          callback(null, { data: Buffer.alloc(0) });
        });
    },
    ratio: 1,
  });

  map.load(JSON.stringify(STYLE));
  console.log("Style loaded, rendering tiles...");
  console.log("Requests so far:", requestLog);

  const startTime = Date.now();

  for (let i = 0; i < tiles.length; i++) {
    const { z, x, y } = tiles[i];
    const outPath = path.join(outputDir, `${z}`, `${x}`, `${y}.png`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    requestLog.length = 0;
    try {
      const buffer = await renderTile(map, z, x, y);
      if (i === 0) {
        console.log("First tile requests:", requestLog);
      }

      // MapLibre Native returns premultiplied RGBA at 512x512; downscale to 256x256
      await sharp(buffer, {
        raw: { width: RENDER_SIZE, height: RENDER_SIZE, channels: 4 },
      })
        .resize(TILE_SIZE, TILE_SIZE)
        .png()
        .toFile(outPath);

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = ((i + 1) / (Date.now() - startTime) * 1000).toFixed(1);
      console.log(
        `  [${i + 1}/${tiles.length}] ${z}/${x}/${y}.png  (${rate} tiles/s, ${elapsed}s)`
      );
    } catch (err) {
      console.error(`  Error rendering ${z}/${x}/${y}: ${err.message}`);
    }
  }

  map.release();
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Done. ${tiles.length} tiles in ${totalTime}s -> ${outputDir}/`);
}

main().catch(console.error);
