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

function rewriteLegacyTileURL(url) {
  // EMF 2026 map server moved from /maps/buildmap/{z}/{x}/{y}.pbf
  // to /tiles/_main/{z}/{x}/{y}.
  if (url.includes("/maps/buildmap/")) {
    return url
      .replace("/maps/buildmap/", "/tiles/_main/")
      .replace(/\.pbf(?:\?.*)?$/, "");
  }
  return url;
}

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
    const resolvedURL = rewriteLegacyTileURL(url);
    const mod = resolvedURL.startsWith("https") ? https : http;
    mod
      .get(resolvedURL, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return fetchURL(res.headers.location).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${resolvedURL}`));
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
const STYLE = JSON.parse(
  fs.readFileSync(path.join(__dirname, "web-map-style.json"), "utf8")
);

function applyOfficialDefaultVisibility(style) {
  // Mirrors the official web map defaults:
  // enabled: Background, Structures, Paths
  // disabled: Slope, Hillshade, Aerial Imagery, Buried Services, Lighting
  const layerPrefixes = {
    Background: "background_",
    Slope: "slope",
    Hillshade: "hillshade",
    "Aerial Imagery": "ortho",
    Structures: "structures_",
    Paths: "paths_",
    "Buried Services": "services_",
    Lighting: "lighting_",
  };
  const enabledByDefault = new Set(["Background", "Structures", "Paths"]);

  style.layers = style.layers.map((layer) => {
    for (const [groupName, prefix] of Object.entries(layerPrefixes)) {
      if (layer.id.startsWith(prefix)) {
        const layout = layer.layout ? { ...layer.layout } : {};
        layout.visibility = enabledByDefault.has(groupName)
          ? "visible"
          : "none";
        return { ...layer, layout };
      }
    }
    return layer;
  });

  return style;
}

applyOfficialDefaultVisibility(STYLE);

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
  let outputDir = path.join(__dirname, "tiles");

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
