#!/bin/bash

# hangwin/mcp-chrome 源码集成 - 安装脚本
# 自动化完整的安装流程

set -e

echo "=========================================="
echo "Qwen Code MCP Chrome Integration - 安装向导"
echo "=========================================="
echo ""

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# 检查是否在正确的目录
if [ ! -f "package.json" ]; then
  echo -e "${RED}❌ 错误：请在 packages/mcp-chrome-integration 目录下运行此脚本${NC}"
  exit 1
fi

# 检查 Node.js 版本
echo "📋 检查环境..."
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js 未安装${NC}"
    echo "请先安装 Node.js 18+ : https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}❌ Node.js 版本过低 (当前: v$NODE_VERSION, 需要: v18+)${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Node.js 版本: $(node -v)${NC}"

# 检查 pnpm
if ! command -v pnpm &> /dev/null; then
    echo -e "${RED}❌ pnpm 未安装${NC}"
    echo "请先安装 pnpm: npm install -g pnpm"
    exit 1
fi

echo -e "${GREEN}✅ pnpm 版本: $(pnpm -v)${NC}"
echo ""

# 1. 安装依赖
echo "📦 [步骤 1/4] 安装依赖..."
pnpm install
echo -e "${GREEN}✅ 依赖安装完成${NC}"
echo ""

# 2. 构建所有组件
echo "🔨 [步骤 2/4] 构建所有组件..."
chmod +x scripts/build-all.sh
./scripts/build-all.sh
echo ""

# 3. 注册 Native Messaging
echo "🔗 [步骤 3/4] 注册 Native Messaging Host..."
cd app/native-server
node dist/cli.js register
cd ../..
echo -e "${GREEN}✅ Native Messaging Host 已注册${NC}"
echo ""

# 4. 验证安装
echo "🔍 [步骤 4/4] 验证安装..."
cd app/native-server
node dist/cli.js doctor
cd ../..
echo ""

echo "=========================================="
echo -e "${GREEN}🎉 安装完成！${NC}"
echo "=========================================="
echo ""
echo "接下来的步骤："
echo ""
echo "1. 加载 Chrome Extension:"
echo "   a. 打开 Chrome 浏览器"
echo "   b. 访问 chrome://extensions/"
echo "   c. 启用右上角的"开发者模式""
echo "   d. 点击"加载已解压的扩展程序""
echo "   e. 选择目录: $(pwd)/app/chrome-extension/dist/extension"
echo ""
echo "2. 记录 Extension ID:"
echo "   - 加载后，Extension 卡片上会显示 ID (例如: abcdefghijklmnopqrstuvwxyz123456)"
echo "   - 记下这个 ID，后续更新 Native Messaging 配置时需要"
echo ""
echo "3. 更新 Native Messaging 配置（如果 Extension ID 改变）:"
echo "   macOS: ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.qwen.mcp_chrome_bridge.json"
echo "   更新 allowed_origins 字段为: chrome-extension://YOUR_EXTENSION_ID/"
echo ""
echo "4. 配置 Qwen CLI:"
echo "   在 Qwen CLI 配置文件中添加:"
echo '   {'
echo '     "mcpServers": {'
echo '       "chrome": {'
echo '         "command": "node",'
echo '         "args": ["'$(pwd)'/app/native-server/dist/index.js"]'
echo '       }'
echo '     }'
echo '   }'
echo ""
echo "🎯 提示："
echo "   - 如需重新构建: ./scripts/build-all.sh"
echo "   - 查看详细文档: docs/implementation-plan.md"
echo ""
echo -e "${GREEN}✨ 享受更强大的浏览器自动化能力！${NC}"

