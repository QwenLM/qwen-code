#!/usr/bin/env bash
# Scenario 1 — baseline parallel/serial comparison.
#
# Same prompt asks for 3 independent safe tool calls (read_file + glob +
# grep_search). flag-off runs them serially after the stream ends; flag-on
# kicks them off as soon as each tool-call payload closes mid-stream.
# Expected outcome: identical final summary (semantic match), shorter median
# wall time with flag on.

set -uo pipefail
source "$(dirname "$0")/lib.sh"

RUNS="${RUNS:-3}"
PROMPT='Do exactly three things and then summarize, no other tools:
1. Read the file packages/core/src/core/streamingToolDispatcher.ts (just enough to see the header comment).
2. List the files under packages/core/src/utils (use a glob like packages/core/src/utils/*.ts).
3. Search the codebase for the exact string "StreamingToolExecutor" under packages/core/src.
Then in two sentences summarize what the dispatcher is for. Do not edit any files.'

section "Scenario: baseline (flag-off vs flag-on, RUNS=$RUNS)"

declare -a off_times on_times

for i in $(seq 1 "$RUNS"); do
  echo
  echo "[baseline] run $i/$RUNS — flag OFF"
  run_cli_once "baseline-off-$i" "$PROMPT" off "" || echo "  exit non-zero"
  off_times+=("$(cat "$RESULTS_DIR/baseline-off-$i.time")")
  echo "  wall=$(cat "$RESULTS_DIR/baseline-off-$i.time")s"

  echo "[baseline] run $i/$RUNS — flag ON"
  run_cli_once "baseline-on-$i" "$PROMPT" on "" || echo "  exit non-zero"
  on_times+=("$(cat "$RESULTS_DIR/baseline-on-$i.time")")
  echo "  wall=$(cat "$RESULTS_DIR/baseline-on-$i.time")s"
done

off_median="$(median3 "${off_times[@]}")"
on_median="$(median3 "${on_times[@]}")"

{
  echo "scenario=baseline"
  echo "runs=$RUNS"
  echo "off_wall_seconds=${off_times[*]}"
  echo "on_wall_seconds=${on_times[*]}"
  echo "off_median_s=$off_median"
  echo "on_median_s=$on_median"
  python3 -c "
off=$off_median; on=$on_median
if off>0:
    pct=(off-on)/off*100
    print(f'speedup_pct={pct:.1f}')
else:
    print('speedup_pct=nan')
"
} > "$RESULTS_DIR/baseline-summary.txt"

section "Baseline summary"
cat "$RESULTS_DIR/baseline-summary.txt"

# Sanity: do both ends produce non-empty stdout?
for i in $(seq 1 "$RUNS"); do
  for f in "baseline-off-$i" "baseline-on-$i"; do
    sz=$(wc -c <"$RESULTS_DIR/$f.stdout" | tr -d ' ')
    if [[ "$sz" -lt 20 ]]; then
      echo "WARN: $f.stdout looks empty ($sz bytes)"
    fi
  done
done
