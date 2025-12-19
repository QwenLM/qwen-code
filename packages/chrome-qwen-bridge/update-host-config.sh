#!/bin/bash

echo "🔧 更新 Native Host 配置..."

CONFIG_FILE="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.qwen.cli.bridge.json"
RUN_SCRIPT="$PWD/native-host/run.sh"

# 创建新的配置
cat > "$CONFIG_FILE" <<EOF
{
  "name": "com.qwen.cli.bridge",
  "description": "Native messaging host for Qwen CLI Bridge",
  "path": "$RUN_SCRIPT",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://*/"]
}
EOF

echo "✅ 配置已更新"
echo ""
echo "配置内容:"
cat "$CONFIG_FILE"
echo ""
echo "现在请:"
echo "1. 重新加载 Chrome 扩展 (chrome://extensions/)"
echo "2. 点击扩展图标测试连接"