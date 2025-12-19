#!/bin/bash

# 快速测试脚本

echo "🔍 检查 Chrome 扩展配置..."
echo ""

# 检查目录结构
echo "📂 目录结构："
ls -la extension/ | grep -E "background|content|icons|options|popup"
echo ""

# 检查 manifest.json
echo "📄 Manifest 配置："
cat extension/manifest.json | grep -E "options_ui|version|name" | head -5
echo ""

# 检查关键文件
echo "✅ 文件检查："
FILES=(
    "extension/manifest.json"
    "extension/popup/popup.html"
    "extension/popup/popup.js"
    "extension/options/options.html"
    "extension/options/options.js"
    "extension/background/service-worker.js"
    "extension/content/content-script.js"
)

for file in "${FILES[@]}"; do
    if [[ -f "$file" ]]; then
        echo "  ✓ $file"
    else
        echo "  ✗ $file - 缺失!"
    fi
done

echo ""
echo "💡 提示："
echo "  1. 在 Chrome 中重新加载扩展 (chrome://extensions/)"
echo "  2. 点击扩展图标测试功能"
echo "  3. 如有错误，查看 Chrome DevTools Console"
echo ""
echo "🚀 运行 'npm run dev' 启动完整调试环境"