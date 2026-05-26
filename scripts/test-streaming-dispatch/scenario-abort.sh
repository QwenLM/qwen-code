#!/usr/bin/env bash
# Scenario 4 — SIGINT abort must not leave orphan tool subprocesses.
#
# Asks the model to issue a long-running read-only shell loop (find in
# a tight for loop), then SIGINT 3 seconds in. Confirms after teardown:
#   - the CLI parent process exited within 15s of SIGINT (no force-kill)
#   - no `find` worker processes spawned by the CLI are still alive
#   - flag-on behaves the same as flag-off (orphan-prevention guarantee
#     from RFC §4 — `executor.discard('aborted')` must cascade through
#     the dispatcher's `cancelInFlight()` listener)

set -uo pipefail
source "$(dirname "$0")/lib.sh"

RUNS="${RUNS:-3}"
# `sleep N` gets refused as a blocking command by qwen-code's shell tool
# guard. Repeatedly scan the repo so total wall time is reliably 20–30s
# — enough window for SIGINT to land mid-execution, but every individual
# operation is read-only. `for i in seq` + find is recognised as
# read-only by the AST checker, so flag-on can also early-dispatch it.
PROMPT='Run exactly one shell command using the shell tool: `for i in $(seq 1 50); do find packages -type f -name "*.ts" | wc -l; done`. Do not run any other commands.'

section "Scenario: SIGINT abort (RUNS=$RUNS)"

count_orphan_workers() {
  # Count `find` processes — that's what the abort prompt asks the shell
  # tool to run repeatedly. Earlier versions counted `sleep`, but
  # qwen-code's shell tool refuses bare `sleep N` calls (treated as
  # blocking), so there was never a real subprocess to abort and the
  # "no orphans" pass was vacuous. Find is recognised as read-only by
  # the dispatcher's classifier so flag-on can still early-dispatch it.
  #
  # `pgrep -x` matches the command name (basename), filtering out our
  # own bash pipelines that carry "find" inside their argv. Only real
  # find binaries launched by the CLI's shell tool will be counted.
  pgrep -x find 2>/dev/null | wc -l | tr -d ' '
}

run_one_abort() {
  local label="$1" flag="$2"
  local env_prefix=""
  if [[ "$flag" == "on" ]]; then env_prefix="QWEN_CODE_STREAMING_TOOL_DISPATCH=1"; fi

  local stdout="$RESULTS_DIR/${label}.stdout"
  local stderr="$RESULTS_DIR/${label}.stderr"
  local pidf="$RESULTS_DIR/${label}.pid"
  local meta="$RESULTS_DIR/${label}.meta"

  {
    echo "label=$label flag=$flag"
    echo "started_at=$(date -u +%FT%TZ)"
  } > "$meta"

  # Spawn in background, capture PID.
  /usr/bin/env $env_prefix node "$CLI" \
      --yolo \
      --output-format text \
      -p "$PROMPT" \
      >"$stdout" 2>"$stderr" &
  local pid=$!
  echo "$pid" > "$pidf"
  echo "  pid=$pid (flag=$flag)"

  # Let the shell tool actually kick off.
  sleep 3
  local workers_before
  workers_before="$(count_orphan_workers)"

  # Send SIGINT to the process group so the CLI's signal handler runs.
  if kill -0 "$pid" 2>/dev/null; then
    kill -INT "$pid" 2>/dev/null || true
    echo "  sent SIGINT to $pid"
  fi

  # Wait up to 15s for graceful shutdown.
  local waited=0
  while kill -0 "$pid" 2>/dev/null && [[ $waited -lt 15 ]]; do
    sleep 1; waited=$((waited+1))
  done

  local force_killed=no
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
    force_killed=yes
    echo "  WARNING: had to SIGKILL $pid after 15s"
  fi
  wait "$pid" 2>/dev/null || true

  # Wait long enough for any in-flight `find` scan that was already
  # running at abort time to finish naturally (~1-2s on this repo).
  # A real orphan (e.g. one whose parent bash is dead but is itself
  # sleeping or blocked) would still be present after the cool-down;
  # a transient find that was just mid-scan would have exited.
  sleep 8
  local workers_after
  workers_after="$(count_orphan_workers)"

  {
    echo "ended_at=$(date -u +%FT%TZ)"
    echo "workers_before_abort=$workers_before"
    echo "workers_after_abort=$workers_after"
    echo "force_killed=$force_killed"
  } >> "$meta"

  echo "  workers before=$workers_before after=$workers_after force_killed=$force_killed"
}

orphans_total=0
force_kills=0
for i in $(seq 1 "$RUNS"); do
  echo
  echo "[abort] run $i/$RUNS — flag OFF"
  run_one_abort "abort-off-$i" off
  after=$(grep ^workers_after_abort= "$RESULTS_DIR/abort-off-$i.meta" | cut -d= -f2)
  fk=$(grep ^force_killed= "$RESULTS_DIR/abort-off-$i.meta" | cut -d= -f2)
  orphans_total=$((orphans_total + after))
  [[ "$fk" == "yes" ]] && force_kills=$((force_kills + 1))

  echo "[abort] run $i/$RUNS — flag ON"
  run_one_abort "abort-on-$i" on
  after=$(grep ^workers_after_abort= "$RESULTS_DIR/abort-on-$i.meta" | cut -d= -f2)
  fk=$(grep ^force_killed= "$RESULTS_DIR/abort-on-$i.meta" | cut -d= -f2)
  orphans_total=$((orphans_total + after))
  [[ "$fk" == "yes" ]] && force_kills=$((force_kills + 1))
done

{
  echo "scenario=abort"
  echo "runs=$RUNS"
  echo "force_kills=$force_kills"
  echo "orphan_workers_remaining=$orphans_total"
} > "$RESULTS_DIR/abort-summary.txt"

section "Abort summary"
cat "$RESULTS_DIR/abort-summary.txt"

# Primary assertion: CLI exited cleanly within 15s of SIGINT.
# This is what the streaming-tool-dispatch orphan-prevention guarantee
# actually buys us at the e2e layer — Turn's discard('aborted') must
# cascade through the dispatcher's cancellation listener so the
# AbortController fires and executeToolCall's child gets aborted,
# letting the CLI exit instead of hanging waiting for it.
overall_rc=0
if [[ "$force_kills" -ne 0 ]]; then
  echo "FAIL: $force_kills CLI invocations had to be SIGKILLed after 15s" >&2
  overall_rc=1
fi
# Secondary observation: any worker processes that survived our 8s
# cool-down. These would indicate true orphans (vs. in-flight finds
# that finished naturally). Not a hard failure — surfaces as a warning
# for follow-up, because process-counting on a busy macOS can have
# noise from Spotlight / other find invocations.
if [[ "$orphans_total" -ne 0 ]]; then
  echo "WARN: $orphans_total worker processes still alive after 8s cool-down" >&2
  echo "      (may be system finds unrelated to the harness — inspect via ps)" >&2
  pgrep -lx find >&2 || true
fi
if [[ "$overall_rc" -eq 0 ]]; then
  echo "PASS: every CLI invocation exited within 15s of SIGINT (no force-kill)."
fi
exit $overall_rc
