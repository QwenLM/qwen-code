#!/bin/bash
# Startup Performance Benchmark
# Measures baseline CLI startup time (module loading, initialization overhead).
#
# Note: This uses `--version` which exits before the preconnect code path.
# To measure the actual preconnect effect on TCP+TLS handshake time,
# use benchmark-api-latency.sh instead.

set -e

ITERATIONS=${ITERATIONS:-10}
RESULTS_DIR=$(mktemp -d)
trap "rm -rf $RESULTS_DIR" EXIT
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
CLI_CMD=${CLI_CMD:-"qwen"}

echo "=== Qwen Code Startup Time Benchmark ==="
echo "Iterations: $ITERATIONS"
echo "Timestamp: $TIMESTAMP"
echo "CLI Command: $CLI_CMD"
echo ""

# Function: calculate statistics
calculate_stats() {
  local file=$1
  local name=$2

  if command -v python3 &> /dev/null; then
    python3 - <<EOF
import statistics
import sys

with open('$file') as f:
    lines = f.readlines()[1:]  # Skip header
    data = []
    for x in lines:
        x = x.strip()
        if x and x.replace('.', '').replace('-', '').isdigit():
            data.append(float(x))

if data:
    mean = statistics.mean(data)
    median = statistics.median(data)
    try:
        stdev = statistics.stdev(data)
    except:
        stdev = 0
    p95_idx = int(len(sorted(data)) * 0.95)
    p95 = sorted(data)[min(p95_idx, len(data)-1)]

    print(f"$name:")
    print(f"  Samples: {len(data)}")
    print(f"  Mean: {mean:.2f}ms")
    print(f"  Median: {median:.2f}ms")
    print(f"  StdDev: {stdev:.2f}ms")
    print(f"  P95: {p95:.2f}ms")
    print(f"  Min: {min(data):.2f}ms")
    print(f"  Max: {max(data):.2f}ms")
else:
    print("No valid data found")
EOF
  else
    echo "Python3 not available, skipping statistics calculation"
  fi
}

# Baseline startup time
echo "Baseline startup time (--version):"
echo "Startup Time" > "$RESULTS_DIR/startup_$TIMESTAMP.txt"

for i in $(seq 1 $ITERATIONS); do
  start=$(node -e "console.log(Date.now())")
  $CLI_CMD --version > /dev/null 2>&1
  end=$(node -e "console.log(Date.now())")

  elapsed=$((end - start))
  echo "$elapsed" >> "$RESULTS_DIR/startup_$TIMESTAMP.txt"
  echo "  Run $i: ${elapsed}ms"
done

# Calculate statistics and output results
echo ""
echo "=== Results ==="
echo ""

calculate_stats "$RESULTS_DIR/startup_$TIMESTAMP.txt" "Startup Time (--version)"
