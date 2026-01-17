#!/bin/bash

# hangwin/mcp-chrome 源码集成 - 构建脚本
# 构建所有组件

set -e

echo "=========================================="
echo "开始构建 Qwen Code MCP Chrome Integration"
echo "=========================================="
echo ""

# 1. 构建 shared 包
echo "📦 [1/3] 构建 shared 包..."
cd packages/shared
pnpm install
pnpm build
cd ../..
echo "✅ Shared 包构建完成"
echo ""

# 2. 构建 native-server
echo "🔧 [2/3] 构建 native-server..."
cd app/native-server
pnpm install
pnpm build
cd ../..
echo "✅ Native-server 构建完成"
echo ""

# 3. 构建 chrome-extension
echo "🌐 [3/3] 构建 Chrome Extension..."
cd app/chrome-extension
pnpm install
pnpm build
cd ../..
echo "✅ Chrome Extension 构建完成"
echo ""

echo "=========================================="
echo "✅ 所有组件构建完成！"
echo "=========================================="
echo ""
echo "下一步："
echo "  1. 注册 Native Messaging:"
echo "     cd app/native-server && node dist/cli.js register"
echo ""
echo "  2. 验证注册:"
echo "     cd app/native-server && node dist/cli.js doctor"
echo ""
echo "  3. 加载 Chrome Extension:"
echo "     - 打开 chrome://extensions/"
echo "     - 启用开发者模式"
echo "     - 加载 app/chrome-extension/dist/extension"
echo ""
