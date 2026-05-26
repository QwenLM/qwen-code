#!/usr/bin/env bash
# Shared helpers for the streaming-tool-dispatch tmux test harness.
# Sourced by every scenario script via `source "$(dirname "$0")/lib.sh"`.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI="$REPO_ROOT/packages/cli/dist/index.js"
RESULTS_ROOT="$REPO_ROOT/scripts/test-streaming-dispatch/test-results"

if [[ ! -f "$CLI" ]]; then
  echo "FATAL: $CLI not found. Run 'npm run build' first." >&2
  exit 1
fi

# Init a per-run results dir under $RESULTS_ROOT and export $RESULTS_DIR.
init_run_dir() {
  local stamp
  stamp="$(date +%Y%m%d-%H%M%S)"
  RESULTS_DIR="$RESULTS_ROOT/$stamp"
  mkdir -p "$RESULTS_DIR"
  export RESULTS_DIR
  echo "Results dir: $RESULTS_DIR"
}

# Run the CLI once with given flag state. Captures wall time + stdout/stderr.
#   $1: label   — short name written into log filenames
#   $2: prompt  — the user prompt
#   $3: flag    — "off" or "on"
#   $4: extra args (single string, may be empty) — e.g. --json-schema @...
#
# Writes to $RESULTS_DIR/<label>.stdout, .stderr, .time, .meta
run_cli_once() {
  local label="$1" prompt="$2" flag="$3" extra="${4:-}"
  local env_prefix=""
  if [[ "$flag" == "on" ]]; then
    env_prefix="QWEN_CODE_STREAMING_TOOL_DISPATCH=1"
  fi
  # Re-check dist on every call: a background watcher / rebuild can wipe
  # it mid-sweep and we'd otherwise get cryptic "Cannot find module" lines
  # in stderr that look like our bug. Wait briefly for it to come back.
  for _ in 1 2 3 4 5; do
    [[ -f "$CLI" ]] && break
    sleep 1
  done
  if [[ ! -f "$CLI" ]]; then
    echo "FATAL: $CLI disappeared mid-run (rebuild?)" >&2
    return 99
  fi

  local stdout="$RESULTS_DIR/${label}.stdout"
  local stderr="$RESULTS_DIR/${label}.stderr"
  local timef="$RESULTS_DIR/${label}.time"
  local meta="$RESULTS_DIR/${label}.meta"

  {
    echo "label=$label"
    echo "flag=$flag"
    echo "extra=$extra"
    echo "prompt=$prompt"
    echo "started_at=$(date -u +%FT%TZ)"
  } > "$meta"

  local t0
  t0="$(python3 -c 'import time; print(time.time())')"

  # shellcheck disable=SC2086  # we want $extra to word-split
  /usr/bin/env $env_prefix node "$CLI" \
      --yolo \
      --output-format text \
      $extra \
      -p "$prompt" \
      >"$stdout" 2>"$stderr"
  local rc=$?

  local t1
  t1="$(python3 -c 'import time; print(time.time())')"
  python3 -c "print(f'{($t1) - ($t0):.3f}')" > "$timef"

  {
    echo "ended_at=$(date -u +%FT%TZ)"
    echo "exit_code=$rc"
    echo "wall_seconds=$(cat "$timef")"
  } >> "$meta"

  return $rc
}

# Spawn or reuse a detached tmux session and tail the latest run's output.
# Idempotent. Users can `tmux attach -t qwen-stream-test` to watch.
ensure_watch_session() {
  local sess="qwen-stream-test"
  if tmux has-session -t "$sess" 2>/dev/null; then
    return 0
  fi
  tmux new-session -d -s "$sess" -x 220 -y 50 \
    "cd '$REPO_ROOT' && \
     echo 'qwen-stream-test watch session — tail of latest run' && \
     echo 'Run results land under $RESULTS_ROOT/' && \
     echo '' && \
     while true; do \
       latest=\$(ls -1dt $RESULTS_ROOT/*/ 2>/dev/null | head -1); \
       if [[ -n \"\$latest\" ]]; then \
         tail -F \"\$latest\"/*.stdout \"\$latest\"/*.stderr 2>/dev/null; \
       fi; \
       sleep 2; \
     done"
  echo "tmux watch session ready: tmux attach -t $sess"
}

# Trim trailing whitespace + collapse to single newline so diffs are stable.
normalize_text() {
  awk '{sub(/[[:space:]]+$/,""); print}' "$1"
}

# Median of stdin floats — used to summarize 3x wall times.
median3() {
  python3 - "$@" <<'EOF'
import sys, statistics
nums = [float(x) for x in sys.argv[1:] if x]
if not nums:
    print("nan")
else:
    print(f"{statistics.median(nums):.3f}")
EOF
}

# Section header for the report — keeps run output scannable.
section() {
  echo
  echo "============================================================"
  echo "$1"
  echo "============================================================"
}
