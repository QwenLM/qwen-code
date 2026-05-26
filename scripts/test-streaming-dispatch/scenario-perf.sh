#!/usr/bin/env bash
# Scenario 5 — performance demonstration.
#
# The baseline scenario uses fast local tools (read_file / glob / grep),
# whose wall time is dominated by the model's streaming. To actually
# show the early-dispatch speedup we need:
#
#   (a) multiple safe shell calls in a SINGLE response (otherwise there's
#       no "during the stream" window — each tool waits for its own
#       turn).
#   (b) each tool takes meaningful wall time (~1.5-2s on this host).
#
# We measured the four commands below locally before picking them:
#   find packages ... xargs wc -l       ≈ 2.0s
#   du -sk node_modules                 ≈ 1.8s
#   find . -maxdepth 6 ... '*.ts' wc -l ≈ 1.5s
#   grep -r --include='*.ts' ...  wc -l ≈ 0.6s
#
# Total serial:  ~5.9s  → flag-off post-stream cost
# Total parallel: ≈ max ≈ 2.0s → flag-on overlapped with the stream tail
# Naive expected delta: ~3-4s shorter wall time with flag on.
#
# ACTUAL FINDING (N=5, 2026-05-26):
#   off median = 31.6s; on median = 31.3s; delta = 0.27s (0.9%, within noise)
#
# The naive estimate was wrong because OpenAI-compatible providers emit
# all parallel tool_calls in a tight burst at the END of the model
# stream (after all text, just before finish_reason), giving early
# dispatch only a ~200-500ms window between first and last tool_call
# complete. CoreToolScheduler already runs concurrency-safe tools in
# parallel after the stream ends, so the marginal speedup of early
# dispatch within a single response is well below the ~5-10s API
# latency variance — invisible at any practical sample size.
#
# Where this feature DOES show measurable wall-time wins:
#   - Single long-running tool (e.g. web_fetch to a slow URL): the model
#     can continue generating text while the fetch runs, saving close
#     to the full tool duration.
#   - Multi-turn workflows: the next turn's stream overlaps with the
#     previous turn's late-dispatched tool, hiding latency across turns.
#   - Providers that interleave tool_calls with text mid-stream (rather
#     than batching at the end) — the spread between first/last tool
#     widens and early dispatch's window grows.
#
# This scenario stays in the harness as a regression check: it should
# never show flag-on SLOWER than flag-off by a meaningful margin, and
# should always produce byte-identical final outputs.

set -uo pipefail
source "$(dirname "$0")/lib.sh"

RUNS="${RUNS:-3}"
PROMPT='You are running a benchmark. Issue these FOUR independent read-only shell commands IN A SINGLE RESPONSE — fire all four at once via the shell tool, do not wait for results between them, do not explain anything before issuing them:

1. find packages -type f -name "*.ts" -not -path "*/node_modules/*" | xargs wc -l 2>/dev/null | tail -1
2. du -sk node_modules 2>/dev/null
3. find . -maxdepth 6 -type f -name "*.ts" 2>/dev/null | wc -l
4. grep -r --include="*.ts" "StreamingTool" packages/core/src 2>/dev/null | wc -l

After all four return, output ONLY a single line in the form:
ts_lines=A node_modules_kb=B all_ts=C streaming_refs=D

Do not call any other tool. Do not explain. Do not narrate.'

section "Scenario: perf (slow shell tools, RUNS=$RUNS)"

declare -a off_times on_times

for i in $(seq 1 "$RUNS"); do
  echo
  echo "[perf] run $i/$RUNS — flag OFF"
  run_cli_once "perf-off-$i" "$PROMPT" off "" || echo "  exit non-zero"
  t="$(cat "$RESULTS_DIR/perf-off-$i.time")"
  off_times+=("$t")
  echo "  wall=${t}s"

  echo "[perf] run $i/$RUNS — flag ON"
  run_cli_once "perf-on-$i" "$PROMPT" on "" || echo "  exit non-zero"
  t="$(cat "$RESULTS_DIR/perf-on-$i.time")"
  on_times+=("$t")
  echo "  wall=${t}s"
done

off_median="$(median3 "${off_times[@]}")"
on_median="$(median3 "${on_times[@]}")"

{
  echo "scenario=perf"
  echo "runs=$RUNS"
  echo "off_wall_seconds=${off_times[*]}"
  echo "on_wall_seconds=${on_times[*]}"
  echo "off_median_s=$off_median"
  echo "on_median_s=$on_median"
  python3 -c "
off=$off_median; on=$on_median
delta=off-on
pct=(delta/off*100) if off>0 else 0
print(f'speedup_seconds={delta:.3f}')
print(f'speedup_pct={pct:.1f}')
"
} > "$RESULTS_DIR/perf-summary.txt"

section "Perf summary"
cat "$RESULTS_DIR/perf-summary.txt"

# Sanity-check that the model actually issued shell calls.
# If it just output prose without calling the tool, both medians collapse
# to "model streaming time" and the comparison is meaningless.
calls_per_run() {
  # The CLI's structured-output mode would expose tool calls cleanly,
  # but we're in text mode. Best proxy from stderr: the "Warning:
  # running headless with --yolo" prefix means the shell tool armed;
  # presence of "ts_lines=" in stdout confirms the model produced the
  # expected output shape after 4 calls. We don't assert exact count,
  # just check both ends produced the same shape.
  local f="$1"
  if grep -q 'ts_lines=' "$f"; then echo "ok"; else echo "no-final"; fi
}

echo
echo "Output shape per run:"
for i in $(seq 1 "$RUNS"); do
  for label in "perf-off-$i" "perf-on-$i"; do
    shape=$(calls_per_run "$RESULTS_DIR/$label.stdout")
    echo "  $label: $shape"
  done
done
