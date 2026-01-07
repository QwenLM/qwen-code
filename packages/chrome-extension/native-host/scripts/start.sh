#!/bin/bash

# Native Host 启动脚本
# Chrome 在 macOS 上需要这个包装脚本来正确启动 Node.js

# 获取脚本所在目录
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# 日志文件
LOG_FILE="/tmp/qwen-bridge-host.log"

# 记录启动信息
echo "[$(date)] Native Host 启动..." >> "$LOG_FILE"
echo "[$(date)] 工作目录: $DIR" >> "$LOG_FILE"
echo "[$(date)] Node 路径: $(which node)" >> "$LOG_FILE"

# 启动 Node.js Native Host
exec /usr/bin/env node "$DIR/../host.js" 2>> "$LOG_FILE"
