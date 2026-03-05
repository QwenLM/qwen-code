#!/bin/bash
# Progress bar script that overwrites the same line using \r
# Tests PTY's ability to handle carriage return / cursor movement

total=20
for ((i = 1; i <= total; i++)); do
  pct=$((i * 100 / total))
  filled=$((pct / 5))
  empty=$((20 - filled))
  bar=$(printf '%0.s#' $(seq 1 $filled 2>/dev/null))
  space=$(printf '%0.s-' $(seq 1 $empty 2>/dev/null))
  printf "\r[%s%s] %3d%% (%d/%d)" "$bar" "$space" "$pct" "$i" "$total"
  sleep 0.5
done
echo ""
echo "Done!"