#!/usr/bin/env bash
# .fork/generate-patches.sh — Regenerate patch files from .fork/manifest.json.

set -euo pipefail

FORK_DIR="$(cd "$(dirname "$0")" && pwd)"
node "$FORK_DIR/generate-patches.js" "$@"
