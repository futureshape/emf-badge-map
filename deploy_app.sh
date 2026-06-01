#!/usr/bin/env bash
# Deploy the EMF Map app to the badge via mpremote.
# Usage: ./deploy_app.sh

set -euo pipefail

APP_DIR="apps/emf_map"

echo "Creating app directory on badge..."
mpremote mkdir ":$APP_DIR" 2>/dev/null || true

echo "Copying app files..."
for f in app/app.py app/metadata.json app/tildagon.toml; do
  dest="$APP_DIR/$(basename "$f")"
  echo "  $f -> :$dest"
  mpremote cp "$f" ":$dest"
done

echo ""
echo "Done. Restart the badge to load the app."
