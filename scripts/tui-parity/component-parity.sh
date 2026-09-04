#!/usr/bin/env bash
# M5 component-level parity snapshot: render the same fragment under Ink and
# OpenTUI (headless) and diff layout/text. Requires bun. Exit 0 = parity.
set -euo pipefail
cd "$(dirname "$0")/../.."
if ! command -v bun >/dev/null 2>&1; then
  echo "SKIP: bun not on PATH." >&2
  exit 77
fi
bun packages/cli/scripts/opentui-component-parity.tsx
bun packages/cli/scripts/opentui-stats-parity.tsx
bun packages/cli/scripts/opentui-command-parity.ts
