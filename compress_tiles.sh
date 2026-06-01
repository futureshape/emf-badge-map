#!/usr/bin/env bash
# Compress all rendered tiles with pngquant.
# Safe to re-run: already-compressed tiles are skipped if unchanged.
# Usage: ./compress_tiles.sh [tiles_dir]

set -euo pipefail

TILES_DIR="${1:-tiles}"

if ! command -v pngquant &>/dev/null; then
  echo "pngquant not found. Install with: brew install pngquant"
  exit 1
fi

total_before=0
total_after=0
ok=0
skipped=0
errors=0

while IFS= read -r f; do
  before=$(stat -f '%z' "$f")
  if pngquant --force --quality=65-90 --output "$f" -- "$f" 2>/dev/null; then
    after=$(stat -f '%z' "$f")
    pct=$(( (before - after) * 100 / before ))
    echo "OK  ${pct}%  ${before} -> ${after}  $f"
    total_before=$(( total_before + before ))
    total_after=$(( total_after + after ))
    ok=$(( ok + 1 ))
  else
    # pngquant exits non-zero when the output would be larger (already optimised)
    echo "SKIP  $f"
    total_before=$(( total_before + before ))
    total_after=$(( total_after + before ))
    skipped=$(( skipped + 1 ))
  fi
done < <(find "$TILES_DIR" -name '*.png' | sort)

total=$(( ok + skipped + errors ))
saving=$(( (total_before - total_after) * 100 / total_before ))

echo ""
echo "Results: ${total} tiles (${ok} compressed, ${skipped} skipped, ${errors} errors)"
printf "Size:    %.1f KB -> %.1f KB (%d%% reduction)\n" \
  "$(echo "$total_before" | awk '{printf "%.1f", $1/1024}')" \
  "$(echo "$total_after"  | awk '{printf "%.1f", $1/1024}')" \
  "$saving"
