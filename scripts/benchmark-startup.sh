#!/bin/bash
# 启动性能 Benchmark 测试
# 测量 API Preconnect 优化对首次 API 调用延迟的影响

set -e

ITERATIONS=${ITERATIONS:-10}
RESULTS_DIR="./benchmark-results"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
CLI_CMD=${CLI_CMD:-"qwen"}

mkdir -p "$RESULTS_DIR"

echo "=== Qwen Code Startup Optimization Benchmark ==="
echo "Iterations: $ITERATIONS"
echo "Timestamp: $TIMESTAMP"
echo "CLI Command: $CLI_CMD"
echo ""

# 计算 stats 的函数
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

# 测试 1: 冷启动 - 无 Preconnect
echo "Test 1: Cold start without preconnect..."
echo "Without Preconnect" > "$RESULTS_DIR/cold_no_preconnect_$TIMESTAMP.txt"

for i in $(seq 1 $ITERATIONS); do
  # 强制关闭连接（等待一段时间让连接池过期）
  sleep 2

  # 测量启动时间
  start=$(node -e "console.log(Date.now())")
  QWEN_CODE_DISABLE_PRECONNECT=1 $CLI_CMD --version > /dev/null 2>&1
  end=$(node -e "console.log(Date.now())")

  elapsed=$((end - start))
  echo "$elapsed" >> "$RESULTS_DIR/cold_no_preconnect_$TIMESTAMP.txt"
  echo "  Run $i: ${elapsed}ms"
done

# 测试 2: 冷启动 - 有 Preconnect
echo ""
echo "Test 2: Cold start with preconnect..."
echo "With Preconnect" > "$RESULTS_DIR/cold_preconnect_$TIMESTAMP.txt"

for i in $(seq 1 $ITERATIONS); do
  sleep 2

  start=$(node -e "console.log(Date.now())")
  $CLI_CMD --version > /dev/null 2>&1
  end=$(node -e "console.log(Date.now())")

  elapsed=$((end - start))
  echo "$elapsed" >> "$RESULTS_DIR/cold_preconnect_$TIMESTAMP.txt"
  echo "  Run $i: ${elapsed}ms"
done

# 计算统计并输出结果
echo ""
echo "=== Results ==="
echo ""

calculate_stats "$RESULTS_DIR/cold_no_preconnect_$TIMESTAMP.txt" "Without Preconnect"
echo ""
calculate_stats "$RESULTS_DIR/cold_preconnect_$TIMESTAMP.txt" "With Preconnect"

# 计算改进百分比
echo ""
echo "=== Improvement Calculation ==="

python3 - <<EOF
import statistics

def read_data(file):
    with open(file) as f:
        lines = f.readlines()[1:]
        return [float(x.strip()) for x in lines if x.strip() and x.strip().replace('.', '').replace('-', '').isdigit()]

data_without = read_data('$RESULTS_DIR/cold_no_preconnect_$TIMESTAMP.txt')
data_with = read_data('$RESULTS_DIR/cold_preconnect_$TIMESTAMP.txt')

if data_without and data_with:
    mean_without = statistics.mean(data_without)
    mean_with = statistics.mean(data_with)
    improvement = mean_without - mean_with
    improvement_percent = (improvement / mean_without) * 100

    print(f"Improvement: {improvement:.2f}ms ({improvement_percent:.1f}%)")
    print("")

    # 检查是否达到目标
    if improvement_percent >= 10:
        print("✅ SUCCESS: Achieved >= 10% improvement!")
    elif improvement_percent >= 5:
        print("⚠️  PARTIAL: Achieved 5-10% improvement (below target)")
    else:
        print("❌ FAILED: Did not achieve 10% improvement target")
    print("")
    print(f"| Metric | Without Preconnect | With Preconnect | Improvement |")
    print(f"|--------|---------------------|-----------------|-------------|")
    print(f"| Mean   | {mean_without:.2f}ms | {mean_with:.2f}ms | {improvement:.2f}ms ({improvement_percent:.1f}%) |")
EOF

echo ""
echo "Raw data saved to $RESULTS_DIR/"
