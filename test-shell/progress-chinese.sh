#!/bin/bash
# Progress bar script with Chinese text output
# 测试终端进度条显示

total=20
for ((i = 1; i <= total; i++)); do
  pct=$((i * 100 / total))
  filled=$((pct / 5))
  empty=$((20 - filled))
  bar=$(printf '%0.s█' $(seq 1 $filled 2>/dev/null))
  space=$(printf '%0.s░' $(seq 1 $empty 2>/dev/null))
  printf "\r进度: [%s%s] %3d%% (%d/%d) 正在处理..." "$bar" "$space" "$pct" "$i" "$total"
  sleep 0.5
done
echo ""
echo "完成！所有任务已处理完毕。"