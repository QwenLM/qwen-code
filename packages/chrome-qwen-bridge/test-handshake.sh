#!/bin/bash

# Native Host 握手测试脚本

echo "🤝 测试 Native Host 握手..."
echo ""

# 清理旧日志
> /tmp/qwen-bridge-host.log

# 握手消息
TEST_MSG='{"type":"handshake","version":"1.0.0"}'

# 计算消息长度
MSG_LEN=${#TEST_MSG}

printf "发送握手消息: $TEST_MSG\n"
printf "消息长度: $MSG_LEN bytes\n\n"

# 创建一个临时文件来存储二进制数据
TEMP_FILE=$(mktemp)

# 写入长度头（4字节小端序）
printf "\\x$(printf '%02x' $((MSG_LEN & 0xff)))" > "$TEMP_FILE"
printf "\\x$(printf '%02x' $(((MSG_LEN >> 8) & 0xff)))" >> "$TEMP_FILE"
printf "\\x$(printf '%02x' $(((MSG_LEN >> 16) & 0xff)))" >> "$TEMP_FILE"
printf "\\x$(printf '%02x' $(((MSG_LEN >> 24) & 0xff)))" >> "$TEMP_FILE"
# 写入消息内容
printf "$TEST_MSG" >> "$TEMP_FILE"

echo "启动 Native Host 并发送握手消息..."
cat "$TEMP_FILE" | timeout 2 ./native-host/start.sh 2>&1 | od -c | head -10

# 清理临时文件
rm -f "$TEMP_FILE"

echo ""
echo "检查日志文件..."
if [ -f /tmp/qwen-bridge-host.log ]; then
    echo "📋 日志内容:"
    tail -20 /tmp/qwen-bridge-host.log
else
    echo "⚠️ 未找到日志文件"
fi