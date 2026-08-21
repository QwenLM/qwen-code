#!/usr/bin/env bash
# M6 pre-acceptance: run the OpenTUI no-flicker scenario and assert the
# renderer streams with ZERO full-screen clears and balanced DEC 2026.
# Requires: bun on PATH. With QWEN_API_KEY the gate drives a real model
# conversation; without it (e.g. fork PRs, which never receive secrets) it
# falls back to the offline scripted-stream gate.
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
if [ -n "${QWEN_API_KEY:-}" ]; then
  SCENARIO="scripts/tui-parity/fixtures/scenarios/opentui-noflicker.scenario.json"
else
  echo "INFO: QWEN_API_KEY not set — running offline scripted-stream gate." >&2
  SCENARIO="scripts/tui-parity/fixtures/scenarios/opentui-noflicker-offline.scenario.json"
fi
node scripts/tui-parity/runner.mjs --scenario "$SCENARIO" --out "$OUT"

echo "PASS: opentui no-flicker gate (0 full-screen clears, balanced DEC 2026). Report: $OUT"
