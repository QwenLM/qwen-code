#!/bin/bash

# Native Host 连接测试脚本

echo "🔍 测试 Native Host 连接..."
echo ""

# 清理旧日志
> /tmp/qwen-bridge-host.log

# 测试消息
TEST_MSG='{"type":"PING"}'

# 计算消息长度（4字节小端序）
MSG_LEN=${#TEST_MSG}

# 将长度转换为4字节小端序
printf "发送测试消息: $TEST_MSG\n"
printf "消息长度: $MSG_LEN bytes\n\n"

# 发送消息到 Native Host
echo "启动 Native Host 并发送测试消息..."
(
    # 发送长度头（4字节）
    printf "\\x$(printf '%02x' $((MSG_LEN & 0xff)))"
    printf "\\x$(printf '%02x' $(((MSG_LEN >> 8) & 0xff)))"
    printf "\\x$(printf '%02x' $(((MSG_LEN >> 16) & 0xff)))"
    printf "\\x$(printf '%02x' $(((MSG_LEN >> 24) & 0xff)))"
    # 发送消息内容
    printf "$TEST_MSG"
) | ./native-host/start.sh 2>&1 | head -c 100

echo ""
echo ""
echo "检查日志文件..."
if [ -f /tmp/qwen-bridge-host.log ]; then
    echo "📋 日志内容:"
    cat /tmp/qwen-bridge-host.log
else
    echo "⚠️ 未找到日志文件"
fi