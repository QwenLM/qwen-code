#!/usr/bin/env bash
# PTY 自动化 E2E：模拟键盘输入+读屏，复用本机 qwen 配置/凭据做真实模型调用，无需人工。
# 用法: scripts/pty-e2e.sh "你的提示" [wait_sec]
set -euo pipefail
PROMPT="${1:-hi}"; WAIT="${2:-20}"
OUT=$(mktemp /tmp/pty-e2e.XXXXXX.log)
EXP=$(mktemp /tmp/pty-e2e.exp.XXXXXX)
trap 'rm -f "$OUT" "$EXP"' EXIT
# $PROMPT 会被展开进 expect 的 TCL 源码；TCL 双引号字符串里 \ " $ [ 都
# 有替换语义（$var 与 [command] 可注入），四个字符都要先转义。
ESCAPED_PROMPT=$(printf '%s' "$PROMPT" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\$/\\$/g' -e 's/\[/\\[/g')
cat > "$EXP" <<EXP
set timeout $WAIT
log_file -a $OUT
spawn qwen2
sleep 3
send "$ESCAPED_PROMPT"
sleep 1
send "\r"
sleep $WAIT
send "\x03"
sleep 1
close
EXP
expect "$EXP" >/dev/null 2>&1 || true
echo "=== 输入是否显示 ==="; tr -c '[:print:]\n' ' ' < "$OUT" | grep -cF -- "$PROMPT" || true
echo "=== 是否有模型回复/工具/错误 ==="; tr -c '[:print:]\n' ' ' < "$OUT" | grep -a -oE "live error|Error|✗|✓|Read|Bash|markdown|qwen3|Thinking" | sort | uniq -c | head || true
