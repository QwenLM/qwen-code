#!/bin/bash
# 简单的启动时间 Benchmark 测试
# 测量 API Preconnect 优化对启动时间的影响

set -e

ITERATIONS=${ITERATIONS:-5}
CLI_PATH="/Users/jinye.djy/Projects/qwen-code/.claude/worktrees/nested-spinning-diffie/dist/cli.js"

echo "=== Qwen Code Startup Optimization Benchmark ==="
echo "Iterations: $ITERATIONS"
echo "CLI Path: $CLI_PATH"
echo ""

# 函数：计算统计数据
calculate_stats() {
  local file=$1
  local name=$2

  if command -v python3 &> /dev/null; then
    python3 - <<EOF
import statistics

with open('$file') as f:
    lines = f.readlines()[1:]  # Skip header
    data = [float(x.strip()) for x in lines if x.strip() and x.strip().replace('.', '').replace('-', '').isdigit()]

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

# 创建临时目录
RESULTS_DIR=$(mktemp -d)
trap "rm -rf $RESULTS_DIR" EXIT

echo "Test 1: Without Preconnect (baseline)"
echo "Without Preconnect" > "$RESULTS_DIR/no_preconnect.txt"

for i in $(seq 1 $ITERATIONS); do
  sleep 1  # 让连接池过期

  start=$(node -e "console.log(Date.now())")
  QWEN_CODE_DISABLE_PRECONNECT=1 node "$CLI_PATH" --version > /dev/null 2>&1
  end=$(node -e "console.log(Date.now())")

  elapsed=$((end - start))
  echo "$elapsed" >> "$RESULTS_DIR/no_preconnect.txt"
  echo "  Run $i: ${elapsed}ms"
done

echo ""
echo "Test 2: With Preconnect (optimized)"
echo "With Preconnect" > "$RESULTS_DIR/with_preconnect.txt"

for i in $(seq 1 $ITERATIONS); do
  sleep 1  # 让连接池过期

  start=$(node -e "console.log(Date.now())")
  node "$CLI_PATH" --version > /dev/null 2>&1
  end=$(node -e "console.log(Date.now())")

  elapsed=$((end - start))
  echo "$elapsed" >> "$RESULTS_DIR/with_preconnect.txt"
  echo "  Run $i: ${elapsed}ms"
done

# 计算统计
echo ""
echo "=== Results ==="
echo ""

calculate_stats "$RESULTS_DIR/no_preconnect.txt" "Without Preconnect (baseline)"
echo ""
calculate_stats "$RESULTS_DIR/with_preconnect.txt" "With Preconnect (optimized)"

# 计算改进
echo ""
echo "=== Improvement ==="

python3 - <<EOF
import statistics

def read_data(file):
    with open(file) as f:
        lines = f.readlines()[1:]
        return [float(x.strip()) for x in lines if x.strip() and x.strip().replace('.', '').replace('-', '').isdigit()]

data_without = read_data('$RESULTS_DIR/no_preconnect.txt')
data_with = read_data('$RESULTS_DIR/with_preconnect.txt')

if data_without and data_with:
    mean_without = statistics.mean(data_without)
    mean_with = statistics.mean(data_with)
    improvement = mean_without - mean_with
    improvement_percent = (improvement / mean_without) * 100

    print(f"Mean improvement: {improvement:.2f}ms ({improvement_percent:.1f}%)")
    print("")

    # 检查目标
    if improvement_percent >= 10:
        print("✅ SUCCESS: Achieved >= 10% improvement!")
    elif improvement_percent >= 5:
        print("⚠️  PARTIAL: Achieved 5-10% improvement")
    else:
        print("ℹ️  Note: Startup time improvement may not be visible in --version mode")
        print("   Preconnect benefits are most visible during first API call")
    print("")
    print("| Metric | Without Preconnect | With Preconnect | Improvement |")
    print("|--------|---------------------|-----------------|-------------|")
    print(f"| Mean   | {mean_without:.2f}ms | {mean_with:.2f}ms | {improvement:.2f}ms ({improvement_percent:.1f}%) |")
EOF
