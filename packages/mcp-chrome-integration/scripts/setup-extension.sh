#!/bin/bash

echo "===== Chrome 插件安装助手 ====="
echo ""

EXTENSION_PATH="/Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/chrome-extension/dist/extension"
CONFIG_FILE="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.chromemcp.nativehost.json"

echo "📋 步骤 1: 打开 Chrome 扩展页面"
echo "   请手动执行以下操作："
echo ""
echo "   1) 打开 Chrome 浏览器"
echo "   2) 在地址栏输入: chrome://extensions/"
echo "   3) 开启右上角的 '开发者模式' 开关"
echo "   4) 点击 '加载已解压的扩展程序'"
echo "   5) 选择以下路径:"
echo ""
echo "      $EXTENSION_PATH"
echo ""
echo "   按回车键继续..."
read -r

echo ""
echo "📋 步骤 2: 获取插件 ID"
echo ""
echo "   在 Chrome 扩展页面中，找到 'Qwen CLI Chrome Extension'"
echo "   复制插件卡片上的 ID (类似: abcdefghijklmnopqrstuvwxyz123456)"
echo ""
echo -n "   请粘贴插件 ID 并按回车: "
read -r EXTENSION_ID

if [ -z "$EXTENSION_ID" ]; then
    echo "❌ 未输入插件 ID，退出"
    exit 1
fi

# 验证 ID 格式（32个小写字母）
if ! echo "$EXTENSION_ID" | grep -qE '^[a-z]{32}$'; then
    echo "⚠️  警告: 插件 ID 格式可能不正确 (应该是32个小写字母)"
    echo "   继续使用: $EXTENSION_ID"
fi

echo ""
echo "📋 步骤 3: 更新 Native Messaging Host 配置"
echo ""

# 创建备份
if [ -f "$CONFIG_FILE" ]; then
    cp "$CONFIG_FILE" "$CONFIG_FILE.backup"
    echo "✅ 已备份配置文件到: $CONFIG_FILE.backup"
fi

# 更新配置文件
cat > "$CONFIG_FILE" <<EOF
{
  "name": "com.chromemcp.nativehost",
  "description": "Node.js Host for Browser Bridge Extension",
  "path": "/Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/native-server/dist/run_host.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF

echo "✅ 已更新配置文件"
echo ""
echo "新配置:"
cat "$CONFIG_FILE"

echo ""
echo "📋 步骤 4: 重启 Chrome"
echo ""
echo "   请完全退出 Chrome 浏览器（⌘+Q），然后重新打开"
echo ""
echo "   按回车键继续验证连接..."
read -r

echo ""
echo "📋 步骤 5: 验证连接"
echo ""

# 等待几秒钟让 Chrome 启动
sleep 2

# 检查日志
LOG_DIR="$HOME/Library/Logs/mcp-chrome-bridge"
LATEST_LOG=$(ls -t "$LOG_DIR"/native_host_wrapper_* 2>/dev/null | head -1)

if [ -n "$LATEST_LOG" ]; then
    echo "✅ Native Messaging Host 已被调用"
    echo ""
    echo "最新日志摘要:"
    tail -10 "$LATEST_LOG"
else
    echo "⚠️  未检测到新的日志文件"
    echo "   可能需要在 Chrome 中打开插件的 Side Panel"
fi

echo ""
echo "===== 设置完成 ====="
echo ""
echo "💡 下一步:"
echo "   1. 在 Chrome 中点击插件图标，打开 Side Panel"
echo "   2. 在 Cursor 中测试 MCP tools 是否可用"
echo "   3. 如果仍有问题，运行诊断脚本:"
echo "      ./diagnose.sh"
echo ""
