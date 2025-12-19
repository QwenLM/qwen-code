#!/bin/bash

echo "🔍 Chrome Extension 调试启动器"
echo "================================"
echo ""

# 检查 Chrome 是否已经运行
if pgrep -x "Google Chrome" > /dev/null; then
    echo "⚠️  Chrome 已在运行，请先关闭 Chrome 再运行此脚本"
    echo "   或者在新的 Chrome 窗口中手动操作"
    echo ""
fi

# 获取扩展路径
EXTENSION_PATH="$PWD/extension"
echo "📂 扩展路径: $EXTENSION_PATH"

# 读取保存的扩展 ID
if [ -f ".extension-id" ]; then
    EXTENSION_ID=$(cat .extension-id)
    echo "🆔 扩展 ID: $EXTENSION_ID"
else
    echo "⚠️  未找到扩展 ID，首次加载后会自动保存"
fi

echo ""
echo "正在启动 Chrome 调试模式..."
echo ""

# 启动 Chrome with debugging
open -na "Google Chrome" --args \
    --load-extension="$EXTENSION_PATH" \
    --auto-open-devtools-for-tabs \
    --enable-logging \
    --v=1 \
    "file://$PWD/debug-console.html"

echo "✅ Chrome 已启动"
echo ""
echo "📝 调试步骤："
echo "1. Chrome 会自动加载扩展并打开调试控制台"
echo "2. 点击 'Test Connection' 测试连接"
echo "3. 如果连接失败，点击 'View Background Logs' 查看详细日志"
echo ""
echo "💡 提示："
echo "- 按 F12 打开开发者工具查看控制台输出"
echo "- 在 chrome://extensions/ 页面点击 'Service Worker' 查看后台日志"
echo "- 日志文件: /tmp/qwen-bridge-host.log"
echo ""
echo "📋 监控日志 (Ctrl+C 退出):"
echo "----------------------------"
tail -f /tmp/qwen-bridge-host.log 2>/dev/null || echo "等待日志生成..."