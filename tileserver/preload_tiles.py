#!/usr/bin/env python3
"""
Preload all rendered map tiles to the badge cache via mpremote.

Tiles are copied from tiles/{z}/{x}/{y}.png on disk to
/apps/emf_map/cache/{z}_{x}_{y}.png on the badge.

Usage:
    python preload_tiles.py [--zoom 18-20] [--clear-cache] [--dry-run]
"""

import argparse
import glob
import os
import subprocess
import sys

TILES_DIR = os.path.join(os.path.dirname(__file__), "tiles")
BADGE_CACHE = ":apps/emf_map/cache"
BATCH_SIZE = 50  # tiles per mpremote invocation (avoids command-line length limits)


def collect_tiles(min_zoom=None, max_zoom=None):
    tiles = []
    for tile_path in sorted(glob.glob(f"{TILES_DIR}/**/*.png", recursive=True)):
        parts = tile_path.replace("\\", "/").split("/")
        z = int(parts[1])
        if min_zoom is not None and z < min_zoom:
            continue
        if max_zoom is not None and z > max_zoom:
            continue
        x, y_ext = parts[2], parts[3]
        y = y_ext.replace(".png", "")
        cache_name = f"{z}_{x}_{y}.png"
        tiles.append((tile_path, cache_name))
    return tiles


def run_mpremote(cmd, dry_run=False, ignore_errors=False):
    if dry_run:
        print("  [dry-run]", " ".join(cmd))
        return True
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0 and not ignore_errors:
        print(f"  ERROR: {result.stderr.strip() or result.stdout.strip()}")
        return False
    return True


def badge_disk_free(dry_run=False):
    """Return (free_kb, total_kb) from the badge filesystem, or None on error."""
    script = "import os; s=os.statvfs('/'); print(s[3]*s[0],s[2]*s[0])"
    if dry_run:
        return None
    result = subprocess.run(["mpremote", "exec", script], capture_output=True, text=True)
    if result.returncode != 0:
        return None
    try:
        free, total = result.stdout.strip().split()
        return int(free) // 1024, int(total) // 1024
    except Exception:
        return None


def clear_badge_cache(dry_run=False):
    """Delete all files in the badge cache directory."""
    # List files first
    list_script = "import os; [print(f) for f in os.listdir('/apps/emf_map/cache')]"
    result = subprocess.run(["mpremote", "exec", list_script], capture_output=True, text=True)
    if result.returncode != 0:
        print("  Could not list cache (may be empty or missing)")
        return 0
    files = [f.strip() for f in result.stdout.splitlines() if f.strip()]
    if not files:
        print("  Cache already empty.")
        return 0
    print(f"  Removing {len(files)} cached files...")
    # Remove in batches via exec
    BATCH = 50
    removed = 0
    for i in range(0, len(files), BATCH):
        batch = files[i:i + BATCH]
        rm_script = "import os;" + ";".join(
            f"os.remove('/apps/emf_map/cache/{f}')" for f in batch
        )
        if dry_run:
            print(f"  [dry-run] would remove: {batch}")
            removed += len(batch)
        else:
            r = subprocess.run(["mpremote", "exec", rm_script], capture_output=True, text=True)
            if r.returncode != 0:
                print(f"  ERROR removing batch: {r.stderr.strip()}")
            else:
                removed += len(batch)
    return removed



    if dry_run:
        print("  [dry-run]", " ".join(cmd))
        return True
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0 and not ignore_errors:
        print(f"  ERROR: {result.stderr.strip() or result.stdout.strip()}")
        return False
    return True


def main():
    parser = argparse.ArgumentParser(description="Preload map tiles onto Tildagon badge")
    parser.add_argument("--zoom", metavar="MIN-MAX",
                        help="Zoom range to upload, e.g. 18-20 (default: all)")
    parser.add_argument("--clear-cache", action="store_true",
                        help="Clear all cached tiles from the badge before uploading")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print commands without executing")
    args = parser.parse_args()

    min_zoom = max_zoom = None
    if args.zoom:
        parts = args.zoom.split("-")
        min_zoom = int(parts[0])
        max_zoom = int(parts[1]) if len(parts) > 1 else int(parts[0])

    tiles = collect_tiles(min_zoom, max_zoom)
    if not tiles:
        print("No tiles found.")
        sys.exit(1)

    total_size = sum(os.path.getsize(t[0]) for t in tiles)
    print(f"Tiles to upload: {len(tiles)}")
    print(f"Total size:      {total_size / 1024:.1f} KB")
    if min_zoom or max_zoom:
        print(f"Zoom filter:     {min_zoom}-{max_zoom}")

    disk = badge_disk_free(args.dry_run)
    if disk:
        free_kb, total_kb = disk
        print(f"Badge disk:      {free_kb} KB free of {total_kb} KB")
        # Estimate block overhead: flash typically uses 4KB blocks
        block_size_kb = 4
        estimated_kb = len(tiles) * block_size_kb
        print(f"Est. block usage: ~{estimated_kb} KB ({len(tiles)} tiles × {block_size_kb} KB blocks)")
        if estimated_kb > free_kb:
            print(f"  WARNING: estimated usage ({estimated_kb} KB) exceeds free space ({free_kb} KB)")
            print(f"  Consider using --zoom to upload fewer tiles, or --clear-cache first.")
    print()

    # Ensure directories exist on the badge (ignore errors if they already exist)
    print("Creating cache directory on badge...")
    run_mpremote(["mpremote", "mkdir", ":apps/emf_map"], dry_run=args.dry_run, ignore_errors=True)
    run_mpremote(["mpremote", "mkdir", ":apps/emf_map/cache"], dry_run=args.dry_run, ignore_errors=True)
    print()

    if args.clear_cache:
        print("Clearing badge cache...")
        removed = clear_badge_cache(dry_run=args.dry_run)
        print(f"  Removed {removed} files.")
        disk = badge_disk_free(args.dry_run)
        if disk:
            print(f"  Badge disk now: {disk[0]} KB free of {disk[1]} KB")
        print()

    # Upload in batches, chaining copies within each mpremote invocation
    uploaded = 0
    errors = 0
    total = len(tiles)

    for i in range(0, total, BATCH_SIZE):
        batch = tiles[i:i + BATCH_SIZE]
        batch_end = min(i + BATCH_SIZE, total)

        cmd = ["mpremote"]
        for j, (src, dst_name) in enumerate(batch):
            if j > 0:
                cmd.append("+")
            cmd += ["cp", src, f"{BADGE_CACHE}/{dst_name}"]

        label = f"[{i+1:4d}-{batch_end:4d}/{total}]"
        print(f"{label} uploading...", end=" ", flush=True)

        if run_mpremote(cmd, dry_run=args.dry_run):
            uploaded += len(batch)
            batch_size_kb = sum(os.path.getsize(t[0]) for t in batch) / 1024
            print(f"OK  ({batch_size_kb:.1f} KB)")
        else:
            errors += len(batch)
            print("FAILED")

    print()
    print(f"Done: {uploaded}/{total} tiles uploaded", end="")
    if errors:
        print(f", {errors} errors", end="")
    print()


if __name__ == "__main__":
    main()
