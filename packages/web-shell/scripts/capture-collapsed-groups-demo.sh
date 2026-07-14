#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FRAMES_DIR="$ROOT_DIR/docs/assets/web-shell-collapsed-session-groups-frames"
GIF_PATH="$ROOT_DIR/docs/assets/web-shell-collapsed-session-groups.gif"
PORT="${PLAYWRIGHT_PORT:-5175}"

mkdir -p "$ROOT_DIR/docs/assets"

cd "$ROOT_DIR"

CAPTURE_COLLAPSED_GROUPS_DEMO=1 PLAYWRIGHT_PORT="$PORT" \
  npx playwright test \
  --config playwright.config.ts \
  client/e2e/web-shell.collapsed-groups-persist.spec.ts \
  > /tmp/qwen-6870-demo.log 2>&1

python3 "$ROOT_DIR/scripts/frames-to-gif.py" "$FRAMES_DIR" "$GIF_PATH"
echo "Wrote $GIF_PATH"
