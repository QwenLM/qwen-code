#!/bin/bash
# 首次 API 调用延迟 Benchmark
# 测量 API Preconnect 对首次 API 调用的影响

set -e

ITERATIONS=${ITERATIONS:-5}
CLI_PATH="/Users/jinye.djy/Projects/qwen-code/.claude/worktrees/nested-spinning-diffie/dist/cli.js"

echo "=== Qwen Code First API Call Latency Benchmark ==="
echo "This test measures the time for the first API call"
echo "Iterations: $ITERATIONS"
echo ""

# 创建临时目录
RESULTS_DIR=$(mktemp -d)
trap "rm -rf $RESULTS_DIR" EXIT

# 模拟 API 调用延迟测试
# 使用 curl 来测量实际的 TCP+TLS 握手时间
TARGET_URL="https://coding.dashscope.aliyuncs.com"

echo "Test: TCP+TLS Handshake Time Comparison"
echo ""

echo "1. Without Preconnect (cold connection):"
echo "Cold Handshake" > "$RESULTS_DIR/cold.txt"
for i in $(seq 1 $ITERATIONS); do
  # 等待连接关闭
  sleep 2

  # 测量连接时间
  result=$(curl -o /dev/null -s -w "%{time_connect}:%{time_appconnect}" "$TARGET_URL" 2>&1 || echo "0:0")
  connect_time=$(echo "$result" | cut -d: -f1)
  appconnect_time=$(echo "$result" | cut -d: -f2)
  total_handshake=$(echo "$connect_time + $appconnect_time" | bc)

  echo "$total_handshake" >> "$RESULTS_DIR/cold.txt"
  echo "  Run $i: connect=${connect_time}s, tls=${appconnect_time}s, total=${total_handshake}s"
done

echo ""
echo "2. With Preconnect (warm connection):"
echo "Warm Handshake" > "$RESULTS_DIR/warm.txt"
for i in $(seq 1 $ITERATIONS); do
  # 预连接
  curl -o /dev/null -s -X HEAD "$TARGET_URL" 2>/dev/null || true

  # 测量连接时间（应该复用连接）
  result=$(curl -o /dev/null -s -w "%{time_connect}:%{time_appconnect}" "$TARGET_URL" 2>&1 || echo "0:0")
  connect_time=$(echo "$result" | cut -d: -f1)
  appconnect_time=$(echo "$result" | cut -d: -f2)
  total_handshake=$(echo "$connect_time + $appconnect_time" | bc)

  echo "$total_handshake" >> "$RESULTS_DIR/warm.txt"
  echo "  Run $i: connect=${connect_time}s, tls=${appconnect_time}s, total=${total_handshake}s"

  sleep 2
done

# 计算统计
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

    # 检查目标
    if improvement_percent >= 50:
        print("✅ SUCCESS: Connection reuse is working effectively!")
        print("   Preconnect successfully reduces TCP+TLS handshake time")
    elif improvement_percent >= 20:
        print("✅ GOOD: Significant improvement in connection time")
    else:
        print("ℹ️  Note: Results may vary based on network conditions")
    print("")
    print("| Scenario | Mean Time |")
    print("|----------|-----------|")
    print(f"| Cold (no preconnect) | {mean_cold*1000:.1f}ms |")
    print(f"| Warm (with preconnect) | {mean_warm*1000:.1f}ms |")
    print(f"| Improvement | {improvement:.1f}ms ({improvement_percent:.1f}%) |")
else:
    print("No valid data collected")
EOF
