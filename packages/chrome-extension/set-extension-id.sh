#!/bin/bash

echo "🔧 配置 Native Host 使用特定扩展 ID..."

EXTENSION_ID="cimaabkejokbhjkdnajgfniiolfjgbhd"
CONFIG_FILE="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.qwen.cli.bridge.json"
RUN_SCRIPT="$PWD/native-host/run.sh"

# 创建配置（使用特定扩展 ID）
cat > "$CONFIG_FILE" <<EOF
{
  "name": "com.qwen.cli.bridge",
  "description": "Native messaging host for Qwen CLI Bridge",
  "path": "$RUN_SCRIPT",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF

echo "✅ 配置已更新（仅允许扩展 ID: $EXTENSION_ID）"
echo ""
cat "$CONFIG_FILE"