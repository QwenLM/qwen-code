#!/usr/bin/env bash
# Scenario 6 — extreme parallel-tool-count perf test (perf8).
#
# Extends the 4-tool perf scenario by doubling to 8 independent
# read-only shell commands. The naive cumulative-spread hypothesis:
#
#   - 4 tool_calls in the stream → ~200ms each → ~600ms spread
#   - 8 tool_calls in the stream → ~200ms each → ~1.4s spread
#   - earliest tool runs ~1.4s before finish_reason → tool ends
#     close to finish_reason if tool_time ≈ 1.4s
#
# If this holds, flag-on should win by ~1-2s of wall time on this
# workload, which beats the API noise floor we saw at N=5 (~3-5s
# variance per side after the 87s outlier).
#
# Local timings of the 8 picked commands (varying, sum ≈ 10s, max ≈ 2s):
#   1. find packages *.ts xargs wc -l                ≈ 2.0s
#   2. du -sk node_modules                           ≈ 1.8s
#   3. find . -maxdepth 6 *.ts wc -l                 ≈ 1.5s
#   4. find . -path '*/dist/*' *.js wc -l            ≈ 1.6s
#   5. find . -maxdepth 6 *.md wc -l                 ≈ 1.0s
#   6. find packages *.test.ts xargs wc -l           ≈ 0.9s
#   7. grep -rc 'StreamingTool' packages/core/src    ≈ 0.6s
#   8. grep -rc 'describe' packages/core/src         ≈ 0.4s

set -uo pipefail
source "$(dirname "$0")/lib.sh"

RUNS="${RUNS:-5}"
PROMPT='You are running a benchmark. Issue these EIGHT independent read-only shell commands IN A SINGLE RESPONSE — fire all eight at once via the shell tool, do not wait for results between them, do not explain anything before issuing them:

1. find packages -type f -name "*.ts" -not -path "*/node_modules/*" | xargs wc -l 2>/dev/null | tail -1
2. du -sk node_modules 2>/dev/null
3. find . -maxdepth 6 -type f -name "*.ts" 2>/dev/null | wc -l
4. find . -path "*/dist/*" -name "*.js" 2>/dev/null | wc -l
5. find . -maxdepth 6 -type f -name "*.md" 2>/dev/null | wc -l
6. find packages -type f -name "*.test.ts" -not -path "*/node_modules/*" | xargs wc -l 2>/dev/null | tail -1
7. grep -rc "StreamingTool" packages/core/src --include="*.ts" 2>/dev/null | wc -l
8. grep -rc "describe" packages/core/src --include="*.ts" 2>/dev/null | wc -l

After all eight return, output ONLY a single line in the form:
v1=A v2=B v3=C v4=D v5=E v6=F v7=G v8=H

Do not call any other tool. Do not explain. Do not narrate.'

section "Scenario: perf8 (eight slow shell tools, RUNS=$RUNS)"

declare -a off_times on_times

for i in $(seq 1 "$RUNS"); do
  echo
  echo "[perf8] run $i/$RUNS — flag OFF"
  run_cli_once "perf8-off-$i" "$PROMPT" off "" || echo "  exit non-zero"
  t="$(cat "$RESULTS_DIR/perf8-off-$i.time")"
  off_times+=("$t")
  echo "  wall=${t}s"

  echo "[perf8] run $i/$RUNS — flag ON"
  run_cli_once "perf8-on-$i" "$PROMPT" on "" || echo "  exit non-zero"
  t="$(cat "$RESULTS_DIR/perf8-on-$i.time")"
  on_times+=("$t")
  echo "  wall=${t}s"
done

# Sort and compute trimmed median (drop the highest sample on each side
# to filter API latency outliers — N=5 with one outlier dropped gives
# a tighter signal than the raw median).
off_sorted=$(printf '%s\n' "${off_times[@]}" | sort -n)
on_sorted=$(printf '%s\n' "${on_times[@]}" | sort -n)
off_dropmax=$(echo "$off_sorted" | sed '$d')
on_dropmax=$(echo "$on_sorted" | sed '$d')

off_median="$(median3 "${off_times[@]}")"
on_median="$(median3 "${on_times[@]}")"
off_trimmed_median="$(echo "$off_dropmax" | median3 $(echo "$off_dropmax" | tr '\n' ' '))"
on_trimmed_median="$(echo "$on_dropmax" | median3 $(echo "$on_dropmax" | tr '\n' ' '))"

{
  echo "scenario=perf8"
  echo "runs=$RUNS"
  echo "off_wall_seconds=${off_times[*]}"
  echo "on_wall_seconds=${on_times[*]}"
  echo "off_median_s=$off_median"
  echo "on_median_s=$on_median"
  echo "off_trimmed_median_s=$off_trimmed_median  # dropped highest sample"
  echo "on_trimmed_median_s=$on_trimmed_median    # dropped highest sample"
  python3 -c "
import math
off=$off_median; on=$on_median
off_t_raw='$off_trimmed_median'; on_t_raw='$on_trimmed_median'
off_t = float('nan') if off_t_raw=='nan' else float(off_t_raw)
on_t  = float('nan') if on_t_raw =='nan' else float(on_t_raw)
delta=off-on
pct=(delta/off*100) if off>0 else 0
print(f'speedup_seconds={delta:.3f}')
print(f'speedup_pct={pct:.1f}')
if not math.isnan(off_t) and not math.isnan(on_t):
    delta_t=off_t-on_t
    pct_t=(delta_t/off_t*100) if off_t>0 else 0
    print(f'speedup_seconds_trimmed={delta_t:.3f}')
    print(f'speedup_pct_trimmed={pct_t:.1f}')
else:
    print('speedup_seconds_trimmed=nan (trimmed-median computation failed in shell)')
"
} > "$RESULTS_DIR/perf8-summary.txt"

section "Perf8 summary"
cat "$RESULTS_DIR/perf8-summary.txt"

# Verify model issued the expected output shape every time.
echo
echo "Output shape per run:"
for i in $(seq 1 "$RUNS"); do
  for label in "perf8-off-$i" "perf8-on-$i"; do
    if grep -q 'v1=' "$RESULTS_DIR/$label.stdout"; then
      echo "  $label: ok"
    else
      echo "  $label: MISSING v1= line"
    fi
  done
done
