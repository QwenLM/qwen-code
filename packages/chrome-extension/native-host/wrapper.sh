#!/bin/bash
exec 2>> /tmp/qwen-wrapper-error.log
echo "$(date): Wrapper started" >> /tmp/qwen-wrapper-error.log
echo "$(date): PWD=$PWD" >> /tmp/qwen-wrapper-error.log
echo "$(date): Node=$(which node)" >> /tmp/qwen-wrapper-error.log

# 运行实际的 host.js
exec /usr/local/bin/node /Users/yiliang/projects/temp/qwen-code/packages/chrome-extension/native-host/host.js
