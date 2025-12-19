#!/bin/bash

# 快速重新加载 Chrome 扩展的脚本

echo "🔄 重新加载 Chrome 扩展..."
echo ""

# 获取扩展路径
EXTENSION_PATH="$PWD/extension"

# 检查扩展目录
if [ ! -d "$EXTENSION_PATH" ]; then
    echo "❌ 错误: 扩展目录不存在: $EXTENSION_PATH"
    exit 1
fi

echo "📂 扩展路径: $EXTENSION_PATH"
echo ""

# 提示用户操作步骤
echo "请按照以下步骤操作："
echo ""
echo "1️⃣  打开 Chrome 浏览器"
echo "2️⃣  访问 chrome://extensions/"
echo "3️⃣  点击右上角的 '开发者模式' 开关（如果尚未开启）"
echo "4️⃣  如果扩展已加载："
echo "    - 找到 'Qwen CLI Bridge' 扩展"
echo "    - 点击 '重新加载' 按钮 (🔄 图标)"
echo "5️⃣  如果扩展未加载："
echo "    - 点击 '加载已解压的扩展程序'"
echo "    - 选择以下目录："
echo "    $EXTENSION_PATH"
echo ""
echo "6️⃣  点击扩展图标测试功能"
echo "7️⃣  如有错误，按 F12 打开 DevTools 查看控制台"
echo ""

# 如果存在扩展 ID 文件，显示它
if [ -f ".extension-id" ]; then
    EXTENSION_ID=$(cat .extension-id)
    echo "📝 已保存的扩展 ID: $EXTENSION_ID"
    echo ""
fi

# 提供快速打开 Chrome 的命令
echo "💡 快速命令："
echo "   打开扩展页面: open 'chrome://extensions/'"
echo "   查看后台日志: open 'chrome://extensions/?id=<扩展ID>'"
echo ""

# 询问是否要打开 Chrome 扩展页面
read -p "是否要自动打开 Chrome 扩展页面? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    open "chrome://extensions/"
    echo ""
    echo "✅ 已打开 Chrome 扩展页面"
fi

echo ""
echo "🎉 准备完成！请在 Chrome 中重新加载扩展。"