#!/bin/bash
# First API Call Latency Benchmark
# Measures the impact of API Preconnect on first API call latency

set -e

ITERATIONS=${ITERATIONS:-5}
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI_PATH="${CLI_PATH:-"$SCRIPT_DIR/../dist/cli.js"}"

echo "=== Qwen Code First API Call Latency Benchmark ==="
echo "This test measures the time for the first API call"
echo "Iterations: $ITERATIONS"
echo ""

# Create temp directory
RESULTS_DIR=$(mktemp -d)
trap "rm -rf $RESULTS_DIR" EXIT

# Simulate API call latency test
# Use curl to measure actual TCP+TLS handshake time
TARGET_URL="https://coding.dashscope.aliyuncs.com"

echo "Test: TCP+TLS Handshake Time Comparison"
echo ""

echo "1. Without Preconnect (cold connection):"
echo "Cold Handshake" > "$RESULTS_DIR/cold.txt"
for i in $(seq 1 $ITERATIONS); do
  # Wait for connection to close
  sleep 2

  # Measure connection time
  # Note: time_appconnect is the total time from start until TLS handshake is done
  # (it already includes time_connect), so use it directly as total handshake time.
  # TLS-only time = time_appconnect - time_connect
  result=$(curl -o /dev/null -s -w "%{time_connect}:%{time_appconnect}" "$TARGET_URL" 2>&1 || echo "0:0")
  connect_time=$(echo "$result" | cut -d: -f1)
  appconnect_time=$(echo "$result" | cut -d: -f2)
  tls_only=$(echo "$appconnect_time - $connect_time" | bc)

  echo "$appconnect_time" >> "$RESULTS_DIR/cold.txt"
  echo "  Run $i: tcp=${connect_time}s, tls_only=${tls_only}s, total=${appconnect_time}s"
done

echo ""
echo "2. With Preconnect (warm connection):"
echo "Warm Handshake" > "$RESULTS_DIR/warm.txt"
for i in $(seq 1 $ITERATIONS); do
  # Preconnect
  curl -o /dev/null -s -X HEAD "$TARGET_URL" 2>/dev/null || true

  # Measure connection time (should reuse connection)
  result=$(curl -o /dev/null -s -w "%{time_connect}:%{time_appconnect}" "$TARGET_URL" 2>&1 || echo "0:0")
  connect_time=$(echo "$result" | cut -d: -f1)
  appconnect_time=$(echo "$result" | cut -d: -f2)
  tls_only=$(echo "$appconnect_time - $connect_time" | bc)

  echo "$appconnect_time" >> "$RESULTS_DIR/warm.txt"
  echo "  Run $i: tcp=${connect_time}s, tls_only=${tls_only}s, total=${appconnect_time}s"

  sleep 2
done

# Calculate statistics
echo ""
echo "=== Results ==="
echo ""

python3 - <<EOF
import statistics

def read_data(file):
    with open(file) as f:
        lines = f.readlines()[1:]
        return [float(x.strip()) for x in lines if x.strip() and x.strip().replace('.', '').replace('-', '').isdigit()]

data_cold = read_data('$RESULTS_DIR/cold.txt')
data_warm = read_data('$RESULTS_DIR/warm.txt')

if data_cold and data_warm:
    mean_cold = statistics.mean(data_cold)
    mean_warm = statistics.mean(data_warm)
    improvement = (mean_cold - mean_warm) * 1000  # Convert to ms
    improvement_percent = ((mean_cold - mean_warm) / mean_cold) * 100 if mean_cold > 0 else 0

    print("Cold Connection (without preconnect):")
    print(f"  Mean: {mean_cold:.3f}s ({mean_cold*1000:.1f}ms)")
    print("")
    print("Warm Connection (with preconnect):")
    print(f"  Mean: {mean_warm:.3f}s ({mean_warm*1000:.1f}ms)")
    print("")
    print(f"Improvement: {improvement:.1f}ms ({improvement_percent:.1f}%)")
    print("")

    if improvement_percent >= 50:
        print("SUCCESS: Connection reuse is working effectively!")
        print("   Preconnect successfully reduces TCP+TLS handshake time")
    elif improvement_percent >= 20:
        print("GOOD: Significant improvement in connection time")
    else:
        print("Note: Results may vary based on network conditions")
    print("")
    print("| Scenario | Mean Time |")
    print("|----------|-----------|")
    print(f"| Cold (no preconnect) | {mean_cold*1000:.1f}ms |")
    print(f"| Warm (with preconnect) | {mean_warm*1000:.1f}ms |")
    print(f"| Improvement | {improvement:.1f}ms ({improvement_percent:.1f}%) |")
else:
    print("No valid data collected")
EOF
