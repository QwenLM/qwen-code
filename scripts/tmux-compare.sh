#!/usr/bin/env bash
# tmux 前后对比 harness：左 pane 跑原版 qwen（ink），右 pane 跑 qwen2（opentui），
# 发送相同输入，抓取两 pane 输出做对比（渲染/闪屏/鼠标/显示 parity 自测）。
# 用法: ./tmux-compare.sh [prompt]   （需本机 qwen-code 凭据跑真实任务；无凭据时用 qwen2-demo）
set -euo pipefail
PROMPT="${1:-hi}"
SESS=qwcmp
S=$(command -v qwen || true)
S2=$(command -v qwen2 || true)
tmux kill-session -t $SESS 2>/dev/null || true
tmux new-session -d -s $SESS -x 120 -y 40 \; \
  split-window -h \; \
  select-layout tiled >/dev/null
tmux send-keys -t $SESS:0.0 "$S" Enter
tmux send-keys -t $SESS:0.1 "$S2" Enter
sleep 6
# 发送相同 prompt
tmux send-keys -t $SESS:0.0 "$PROMPT" Enter
tmux send-keys -t $SESS:0.1 "$PROMPT" Enter
sleep 12
tmux capture-pane -p -t $SESS:0.0 > /tmp/qwen-ink.txt
tmux capture-pane -p -t $SESS:0.1 > /tmp/qwen-opentui.txt
tmux kill-session -t $SESS 2>/dev/null || true
echo "=== ink (original) ==="; tail -20 /tmp/qwen-ink.txt
echo "=== opentui (qwen2) ==="; tail -20 /tmp/qwen-opentui.txt
echo "=== diff (behavior) ==="; diff /tmp/qwen-ink.txt /tmp/qwen-opentui.txt | head -40 || true
