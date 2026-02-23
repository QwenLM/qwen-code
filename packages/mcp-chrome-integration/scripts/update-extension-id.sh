#!/bin/bash

# 更新 Native Messaging 配置中的 Extension ID

if [ -z "$1" ]; then
  echo "❌ 请提供 Extension ID"
  echo ""
  echo "用法: ./update-extension-id.sh <EXTENSION_ID>"
  echo ""
  echo "获取 Extension ID 的步骤:"
  echo "1. 打开 Chrome: chrome://extensions/"
  echo "2. 启用 '开发者模式'"
  echo "3. 点击 '加载已解压的扩展程序'"
  echo "4. 选择目录: $(pwd)/../app/chrome-extension/dist/extension"
  echo "5. 复制显示的 Extension ID"
  echo "6. 运行: ./update-extension-id.sh <你的ID>"
  exit 1
fi

EXTENSION_ID=$1
MANIFEST_PATH="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.chromemcp.nativehost.json"

echo "📝 更新 Native Messaging 配置..."
echo "Extension ID: $EXTENSION_ID"
echo "Manifest 路径: $MANIFEST_PATH"
echo ""

# 备份原配置
cp "$MANIFEST_PATH" "$MANIFEST_PATH.backup"
echo "✅ 已备份原配置到: $MANIFEST_PATH.backup"

# 更新 Extension ID
cat "$MANIFEST_PATH" | jq --arg id "chrome-extension://$EXTENSION_ID/" '.allowed_origins = [$id]' > "$MANIFEST_PATH.tmp"
mv "$MANIFEST_PATH.tmp" "$MANIFEST_PATH"

echo "✅ 已更新 Extension ID"
echo ""

echo "📄 当前配置:"
cat "$MANIFEST_PATH" | jq .
echo ""

echo "🎉 完成！现在请:"
echo "1. 回到 Chrome Extensions 页面"
echo "2. 点击 Extension 的刷新按钮"
echo "3. 点击 'Inspect views: service worker' 查看控制台"
echo "4. 应该看到 '[NativeMessaging] Connected successfully'"
