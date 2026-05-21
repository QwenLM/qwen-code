#!/usr/bin/env bash
# Scenario 02-lite — single real-Qwen prompt under --trace-warnings.
# Demonstrates the steady-state path emits no MaxListenersExceededWarning.
set -uo pipefail
WT="${WT:-$(git rev-parse --show-toplevel)}"
LOG="$WT/docs/verification/abort-controller-refactor/logs/02-lite-short-prompt.log"
mkdir -p "$(dirname "$LOG")"

NODE_OPTIONS=--trace-warnings node "$WT/packages/cli/dist/index.js" \
  --prompt "Reply with exactly 'OK' and nothing else." > "$LOG" 2>&1 &
PID=$!
for i in $(seq 1 90); do
  if ! kill -0 $PID 2>/dev/null; then break; fi
  sleep 1
done
if kill -0 $PID 2>/dev/null; then kill -9 $PID; echo "TIMEOUT"; exit 1; fi
wait $PID 2>/dev/null
EC=$?

echo "EXIT=$EC"
echo "MaxListenersExceededWarning count: $(grep -c MaxListenersExceededWarning "$LOG")"
echo "--- log ---"
cat "$LOG"
