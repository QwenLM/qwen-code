#!/usr/bin/env bash
# Scenario 06 — headless --prompt + SIGINT. Verifies the agent shuts down
# cleanly when an external signal aborts the in-flight stream.
set -uo pipefail
WT="${WT:-$(git rev-parse --show-toplevel)}"
LOG="$WT/docs/verification/abort-controller-refactor/logs/06-headless-sigint.log"
mkdir -p "$(dirname "$LOG")"

NODE_OPTIONS=--trace-warnings node "$WT/packages/cli/dist/index.js" \
  --prompt "Please write a detailed essay about the history of distributed systems, at least 500 words." > "$LOG" 2>&1 &
PID=$!
sleep 6
kill -INT $PID
wait $PID 2>/dev/null
EC=$?

echo "EXIT_CODE=$EC (expected 130)"
echo "MaxListenersExceededWarning count: $(grep -c MaxListenersExceededWarning "$LOG")"
