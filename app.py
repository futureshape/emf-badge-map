import app
import gc
import os
import sys
import time
import requests

from app_components import clear_background
from events.input import Buttons, BUTTON_TYPES

# Tile server URL (GitHub Pages)
TILE_URL = "https://futureshape.github.io/emf-badge-map/tiles/{z}/{x}/{y}.png"

# Bounding box of rendered tiles
BBOX = {"west": -2.38038, "south": 52.03763, "east": -2.37295, "north": 52.04421}
MIN_ZOOM = 14
MAX_ZOOM = 20
TILE_PX = 256
MAX_CACHED_TILES = 20

# Resolve app folder for local tile cache
if sys.implementation.name == "micropython":
    _apps = os.listdir("/apps")
    _path = ""
    for a in _apps:
        if "emf" in a and "map" in a:
            _path = "/apps/" + a
    CACHE_DIR = _path + "/cache"
    print("MapApp: cache dir =", CACHE_DIR)
else:
    CACHE_DIR = "apps/emf_map/cache"


def _wifi_connect():
    """Ensure wifi is connected (no-op outside MicroPython)."""
    if sys.implementation.name != "micropython":
        return
    try:
        import wifi
        wifi.connect()
        print("MapApp: wifi connected")
    except Exception as e:
        print("MapApp: wifi error:", e)


def _lng_to_x(lng, z):
    return int(((lng + 180.0) / 360.0) * (1 << z))


def _lat_to_y(lat, z):
    import math
    lat_r = lat * math.pi / 180.0
    n = 1 << z
    return int((1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2.0 * n)


def _tile_bounds(z):
    return {
        "x_min": _lng_to_x(BBOX["west"], z),
        "x_max": _lng_to_x(BBOX["east"], z),
        "y_min": _lat_to_y(BBOX["north"], z),
        "y_max": _lat_to_y(BBOX["south"], z),
    }


def _ensure_dir(path):
    """Create directory if it doesn't exist (MicroPython compatible)."""
    try:
        os.mkdir(path)
    except OSError:
        pass


def _file_exists(path):
    try:
        os.stat(path)
        return True
    except OSError:
        return False


def _file_size(path):
    try:
        return os.stat(path)[6]
    except OSError:
        return -1


def _clear_cache():
    """Remove all cached tiles."""
    try:
        files = os.listdir(CACHE_DIR)
    except OSError:
        return
    for f in files:
        try:
            os.remove(CACHE_DIR + "/" + f)
        except OSError:
            pass
    print("MapApp: cache cleared,", len(files), "files removed")


class MapApp(app.App):
    def __init__(self):
        self.button_states = Buttons(self)

        # Start at z17 centered on the bounding box
        self.z = 17
        b = _tile_bounds(self.z)
        self.tx = (b["x_min"] + b["x_max"]) // 2
        self.ty = (b["y_min"] + b["y_max"]) // 2

        self.tile_path = None
        self.status = "Connecting..."
        self.loading = False
        self._needs_fetch = False
        _wifi_connect()
        _clear_cache()
        self._request_tile()

    def _clamp(self):
        b = _tile_bounds(self.z)
        self.tx = max(b["x_min"], min(b["x_max"], self.tx))
        self.ty = max(b["y_min"], min(b["y_max"], self.ty))

    def _cache_path(self, z, x, y):
        return "{}/{}_{}_{}.png".format(CACHE_DIR, z, x, y)

    def _evict_cache(self):
        """Remove oldest cached tiles if over the limit."""
        try:
            files = [f for f in os.listdir(CACHE_DIR) if f.endswith(".png")]
        except OSError:
            return
        if len(files) <= MAX_CACHED_TILES:
            return
        # Sort by name (not ideal but MicroPython has no stat mtime)
        # Remove tiles furthest from current position
        current = "{}_{}_{}.png".format(self.z, self.tx, self.ty)
        files.sort(key=lambda f: 0 if f == current else 1)
        # Keep the first MAX_CACHED_TILES, delete the rest
        for f in files[MAX_CACHED_TILES:]:
            try:
                os.remove(CACHE_DIR + "/" + f)
                print("MapApp: evicted", f)
            except OSError:
                pass

    def _request_tile(self):
        """Request a tile load. If cached, load immediately. Otherwise mark for fetch."""
        self._clamp()
        z, x, y = self.z, self.tx, self.ty
        cached = self._cache_path(z, x, y)

        if _file_exists(cached):
            sz = _file_size(cached)
            print("MapApp: cache hit", cached, sz, "bytes")
            if sz > 0:
                self.tile_path = cached
                self.status = "z{} {}/{}".format(z, x, y)
                return
            else:
                print("MapApp: cached file empty/missing, re-fetching")
                try:
                    os.remove(cached)
                except OSError:
                    pass

        # Show loading and defer the actual fetch to next update()
        # Keep tile_path so we continue showing the previous tile
        self.status = "z{} {}/{}".format(z, x, y)
        self._needs_fetch = True

    def _fetch_tile(self):
        """Download tile if not cached, set self.tile_path."""
        self._clamp()
        z, x, y = self.z, self.tx, self.ty
        cached = self._cache_path(z, x, y)
        gc.collect()
        print("MapApp: mem_free before fetch:", gc.mem_free())

        resp = None
        try:
            _ensure_dir(CACHE_DIR)
            url = TILE_URL.format(z=z, x=x, y=y)
            print("MapApp: fetching", url)
            resp = requests.get(url)
            status = resp.status_code
            if status == 200:
                data = resp.content
                data_len = len(data)
                resp.close()
                del resp
                resp = None
                gc.collect()
                with open(cached, "wb") as f:
                    f.write(data)
                del data
                gc.collect()
                saved_sz = _file_size(cached)
                print("MapApp: saved", cached, "fetched=", data_len, "ondisk=", saved_sz)
                if saved_sz > 0:
                    self.tile_path = cached
                    self.status = "z{} {}/{}".format(z, x, y)
                else:
                    print("MapApp: WARNING saved file is empty!")
                    self.status = "Save err"
                self._evict_cache()
            else:
                print("MapApp: HTTP", status)
                self.status = "HTTP {}".format(status)
                resp.close()
                del resp
                resp = None
        except Exception as e:
            print("MapApp: fetch error:", type(e).__name__, e)
            self.status = str(e)[:30]
        finally:
            if resp is not None:
                try:
                    resp.close()
                    del resp
                except Exception:
                    pass
            gc.collect()
            print("MapApp: mem_free after fetch:", gc.mem_free())

        self.loading = False

    def update(self, delta):
        if self._needs_fetch:
            self._needs_fetch = False
            self._fetch_tile()
            return

        if self.loading:
            return

        gc.collect()

        if self.button_states.get(BUTTON_TYPES["CANCEL"]):
            self.button_states.clear()
            if self.z <= MIN_ZOOM:
                self.minimise()
            else:
                # Zoom out
                cx = self.tx + 0.5
                cy = self.ty + 0.5
                self.z -= 1
                self.tx = int(cx / 2)
                self.ty = int(cy / 2)
                self._request_tile()

        elif self.button_states.get(BUTTON_TYPES["CONFIRM"]):
            self.button_states.clear()
            if self.z < MAX_ZOOM:
                self.tx = self.tx * 2
                self.ty = self.ty * 2
                self.z += 1
                self._request_tile()

        elif self.button_states.get(BUTTON_TYPES["UP"]):
            self.button_states.clear()
            self.ty -= 1
            self._request_tile()

        elif self.button_states.get(BUTTON_TYPES["DOWN"]):
            self.button_states.clear()
            self.ty += 1
            self._request_tile()

        elif self.button_states.get(BUTTON_TYPES["LEFT"]):
            self.button_states.clear()
            self.tx -= 1
            self._request_tile()

        elif self.button_states.get(BUTTON_TYPES["RIGHT"]):
            self.button_states.clear()
            self.tx += 1
            self._request_tile()

    def draw(self, ctx):
        clear_background(ctx)
        ctx.save()

        try:
            if self.tile_path:
                exists = _file_exists(self.tile_path)
                if exists:
                    ctx.image(self.tile_path, -TILE_PX // 2, -TILE_PX // 2, TILE_PX, TILE_PX)
                else:
                    print("MapApp: draw skipped, file gone:", self.tile_path)
            else:
                print("MapApp: draw skipped, no tile_path")
        except Exception as e:
            print("MapApp: draw error:", type(e).__name__, e, "path:", self.tile_path)

        # Loading indicator in centre — pill shape
        if self._needs_fetch or self.loading:
            import math
            R = 14  # pill radius (half-height)
            W = 52  # half-width of centre rectangle
            ctx.rgb(0, 0, 0)
            ctx.arc(-W, 0, R, 0, 2 * math.pi, False).fill()
            ctx.arc( W, 0, R, 0, 2 * math.pi, False).fill()
            ctx.rectangle(-W, -R, W * 2, R * 2).fill()
            ctx.font_size = 18
            ctx.rgb(1, 1, 1).text_align = ctx.CENTER
            ctx.move_to(0, 6).text("Loading...")
            ctx.text_align = ctx.LEFT

        # Status bar at the bottom
        ctx.font_size = 16
        ctx.rgb(0, 0, 0).rectangle(-60, 80, 120, 24).fill()
        ctx.rgba(1, 1, 1, 0.9).move_to(-55, 98).text(self.status)

        ctx.restore()


__app_export__ = MapApp
