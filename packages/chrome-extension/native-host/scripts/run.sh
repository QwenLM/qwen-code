#!/bin/bash

# Native Host 包装脚本 - 确保 Node.js 环境正确设置

# 获取脚本所在目录
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# 设置 Node.js 路径 (使用系统中的 node)
NODE_PATH="/usr/local/bin/node"

# 如果 /usr/local/bin/node 不存在，尝试其他位置
if [ ! -f "$NODE_PATH" ]; then
    NODE_PATH=$(which node)
fi

# 执行 Native Host

# Prefer local CLI build if available and QWEN_CLI_PATH is not set
if [ -z "$QWEN_CLI_PATH" ]; then
  LOCAL_CLI="$DIR/../../cli/dist/index.js"
  if [ -f "$LOCAL_CLI" ]; then
    export QWEN_CLI_PATH="$LOCAL_CLI"
  fi
fi

exec "$NODE_PATH" "$DIR/../host.js"
