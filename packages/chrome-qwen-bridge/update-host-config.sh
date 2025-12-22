#!/bin/bash

echo "🔧 更新 Native Host 配置..."

CONFIG_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
CONFIG_FILE="$CONFIG_DIR/com.qwen.cli.bridge.json"
# 解析绝对路径，避免写入相对路径
RUN_SCRIPT="$(cd "$(pwd -P)" && printf "%s/native-host/run.sh" "$(pwd -P)")"

# 读取扩展 ID（来自 .extension-id 文件），若不存在则提示手动填写
EXT_ID_FILE=".extension-id"
if [ -f "$EXT_ID_FILE" ]; then
  EXT_ID="$(cat "$EXT_ID_FILE" | tr -d '\n' | tr -d '\r')"
else
  echo "⚠️ 未找到 .extension-id 文件，请手动填写扩展 ID。"
  read -p "请输入扩展 ID: " EXT_ID
fi
if [ -z "$EXT_ID" ]; then
  echo "❌ 扩展 ID 为空，退出。"
  exit 1
fi

mkdir -p "$CONFIG_DIR"
chmod +x "$RUN_SCRIPT" 2>/dev/null || true

# 创建新的配置
cat > "$CONFIG_FILE" <<EOF
{
  "name": "com.qwen.cli.bridge",
  "description": "Native messaging host for Qwen CLI Bridge",
  "path": "$RUN_SCRIPT",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF

echo "✅ 配置已更新"
echo ""
echo "配置内容:"
cat "$CONFIG_FILE"
echo ""
echo "现在请:"
echo "1. 重新加载 Chrome 扩展 (chrome://extensions/)"
echo "2. 在扩展侧边栏点击 Connect 测试连接"
