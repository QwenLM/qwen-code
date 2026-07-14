#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
GIF_PATH="$ROOT_DIR/docs/assets/web-shell-collapsed-session-groups.gif"
PORT="${PLAYWRIGHT_PORT:-5175}"

# Private temp dirs avoid symlink races on predictable /tmp paths (CWE-377)
# and keep generated PNG frames out of docs/assets.
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/collapsed-groups-demo.XXXXXX")"
FRAMES_DIR="$TMP_DIR/frames"
LOG_PATH="$TMP_DIR/capture.log"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$ROOT_DIR/docs/assets" "$FRAMES_DIR"

cd "$ROOT_DIR"

CAPTURE_COLLAPSED_GROUPS_DEMO=1 \
CAPTURE_COLLAPSED_GROUPS_FRAMES_DIR="$FRAMES_DIR" \
PLAYWRIGHT_PORT="$PORT" \
  npx playwright test \
  --config playwright.config.ts \
  client/e2e/web-shell.collapsed-groups-persist.spec.ts \
  >"$LOG_PATH" 2>&1

# Requires: pip install Pillow
python3 "$ROOT_DIR/scripts/frames-to-gif.py" "$FRAMES_DIR" "$GIF_PATH"
echo "Wrote $GIF_PATH"
