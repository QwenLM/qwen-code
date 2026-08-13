#!/usr/bin/env bash
# M6 pre-acceptance: run the OpenTUI no-flicker scenario and assert the
# renderer streams with ZERO full-screen clears and balanced DEC 2026.
# Requires: bun on PATH and valid qwen-code credentials (real model stream).
# Usage: scripts/tui-parity/accept-noflicker.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

if ! command -v bun >/dev/null 2>&1; then
  echo "SKIP: bun not on PATH (OpenTUI requires bun)." >&2
  exit 77
fi
if [ ! -f packages/cli/dist/index.js ]; then
  echo "SKIP: packages/cli/dist/index.js missing (run npm run build)." >&2
  exit 77
fi

OUT="${OUT:-/tmp/opentui-noflicker-out}"
node scripts/tui-parity/runner.mjs \
  --scenario scripts/tui-parity/fixtures/scenarios/opentui-noflicker.scenario.json \
  --out "$OUT"

echo "PASS: opentui-noflicker (0 full-screen clears, balanced DEC 2026). Report: $OUT"
