#!/usr/bin/env bash
# tmux 前后对比 harness：左 pane 跑原版 qwen（ink），右 pane 跑 qwen2（opentui），
# 发送相同输入，抓取两 pane 输出做对比（渲染/闪屏/鼠标/显示 parity 自测）。
# 用法: ./tmux-compare.sh [prompt]   （需本机 qwen-code 凭据跑真实任务；无凭据时用 qwen2-demo）
set -euo pipefail
PROMPT="${1:-hi}"
SESS=qwcmp
S=$(command -v qwen || true)
S2=$(command -v qwen2 || true)
if [ -z "$S" ] || [ -z "$S2" ]; then
  echo "需要 qwen 和 qwen2 都在 PATH 中（当前: qwen=${S:-缺失}, qwen2=${S2:-缺失}）" >&2
  exit 1
fi
INK_OUT=$(mktemp /tmp/qwen-ink.XXXXXX.txt)
OTUI_OUT=$(mktemp /tmp/qwen-opentui.XXXXXX.txt)
trap 'rm -f "$INK_OUT" "$OTUI_OUT"' EXIT
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
tmux capture-pane -p -t $SESS:0.0 > "$INK_OUT"
tmux capture-pane -p -t $SESS:0.1 > "$OTUI_OUT"
tmux kill-session -t $SESS 2>/dev/null || true
echo "=== ink (original) ==="; tail -20 "$INK_OUT"
echo "=== opentui (qwen2) ==="; tail -20 "$OTUI_OUT"
echo "=== diff (behavior) ==="; diff "$INK_OUT" "$OTUI_OUT" | head -40 || true
