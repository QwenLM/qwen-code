#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$REPO_ROOT"

echo "==> Installing dependencies..."
bun install

echo "==> Running validate-daily-note locally..."
bun run apps/cli/src/index.ts run \
  --workspace-dir .github/agents \
  --source craft-public \
  --output-format stream-json \
  "Read today's daily note from the Craft source and print its contents. Do not modify anything."
