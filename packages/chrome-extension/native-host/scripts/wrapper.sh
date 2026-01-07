#!/bin/bash
exec 2>> /tmp/qwen-wrapper-error.log
echo "$(date): Wrapper started" >> /tmp/qwen-wrapper-error.log
echo "$(date): PWD=$PWD" >> /tmp/qwen-wrapper-error.log
echo "$(date): Node=$(which node)" >> /tmp/qwen-wrapper-error.log

# 运行实际的 host.js
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
exec /usr/local/bin/node "$SCRIPT_DIR/../host.js"
