#!/usr/bin/env bash
# Top-level harness for the streaming-tool-dispatch feature (PR #4402).
#
# Usage:
#   scripts/test-streaming-dispatch/run.sh                # all scenarios, RUNS=3
#   scripts/test-streaming-dispatch/run.sh baseline       # just baseline
#   RUNS=1 scripts/test-streaming-dispatch/run.sh         # smoke-test, 1 run each
#
# Side-effect: starts a detached tmux session "qwen-stream-test" tailing the
# latest run's logs. Attach with `tmux attach -t qwen-stream-test`.

set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/lib.sh"

scenarios=()
if [[ $# -eq 0 ]]; then
  scenarios=(baseline json-schema shell-bypass abort perf perf8)
else
  scenarios=("$@")
fi

init_run_dir
ensure_watch_session

OVERALL_RC=0
for s in "${scenarios[@]}"; do
  script="$HERE/scenario-${s}.sh"
  if [[ ! -x "$script" ]]; then
    echo "FATAL: no scenario script for '$s' at $script" >&2
    OVERALL_RC=1
    continue
  fi
  section "Running scenario: $s"
  if ! RESULTS_DIR="$RESULTS_DIR" bash "$script"; then
    echo "Scenario $s exited non-zero." >&2
    OVERALL_RC=1
  fi
done

section "Aggregate report"
echo "Results: $RESULTS_DIR"
echo
for f in "$RESULTS_DIR"/*-summary.txt; do
  [[ -f "$f" ]] || continue
  echo "--- $(basename "$f") ---"
  cat "$f"
  echo
done

if [[ $OVERALL_RC -ne 0 ]]; then
  echo "OVERALL: FAIL (at least one scenario reported non-zero)" >&2
else
  echo "OVERALL: PASS"
fi
exit $OVERALL_RC
