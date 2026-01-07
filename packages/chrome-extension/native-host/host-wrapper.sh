#!/bin/bash

# 添加必要的 PATH
export PATH="/usr/local/bin:/Users/yiliang/.npm-global/bin:$PATH"

LOG="/var/folders/sy/9mwf8c3n2b57__q35fyxwdhh0000gp/T/qwen-wrapper.log"
echo "$(date): Wrapper started" >> "$LOG"
echo "$(date): PATH=$PATH" >> "$LOG"

# 使用完整路径运行 node
exec /usr/local/bin/node "$(dirname "$0")/host.js" 2>> "$LOG"
