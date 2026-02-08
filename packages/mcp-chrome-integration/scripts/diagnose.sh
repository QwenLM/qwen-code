#!/bin/bash

# Chrome MCP Integration - 诊断工具
# 检查安装状态，排查常见问题

echo "===== Chrome MCP Integration 诊断工具 ====="
echo ""

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# 获取项目根目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 1. 检查 Node.js
echo "1️⃣  检查 Node.js..."
if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v)
    NODE_PATH=$(which node)
    echo -e "${GREEN}✅ Node.js 已安装: $NODE_VERSION${NC}"
    echo "   路径: $NODE_PATH"

    # 检查版本
    NODE_MAJOR=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_MAJOR" -lt 18 ]; then
        echo -e "${YELLOW}⚠️  Node.js 版本较低，建议升级到 v22+${NC}"
    fi
else
    echo -e "${RED}❌ Node.js 未安装${NC}"
fi
echo ""

# 2. 检查 pnpm
echo "2️⃣  检查 pnpm..."
if command -v pnpm &> /dev/null; then
    PNPM_VERSION=$(pnpm -v)
    echo -e "${GREEN}✅ pnpm 已安装: v$PNPM_VERSION${NC}"
else
    echo -e "${RED}❌ pnpm 未安装${NC}"
    echo "   安装: npm install -g pnpm"
fi
echo ""

# 3. 检查构建产物
echo "3️⃣  检查构建产物..."
EXTENSION_BUILD="$PROJECT_ROOT/app/chrome-extension/dist/extension"
NATIVE_BUILD="$PROJECT_ROOT/app/native-server/dist"

if [ -d "$EXTENSION_BUILD" ] && [ -f "$EXTENSION_BUILD/manifest.json" ]; then
    echo -e "${GREEN}✅ Chrome Extension 已构建${NC}"
    echo "   路径: $EXTENSION_BUILD"
else
    echo -e "${RED}❌ Chrome Extension 未构建${NC}"
    echo "   运行: pnpm run build:extension"
fi

if [ -d "$NATIVE_BUILD" ] && [ -f "$NATIVE_BUILD/index.js" ]; then
    echo -e "${GREEN}✅ Native Server 已构建${NC}"
    echo "   路径: $NATIVE_BUILD"
else
    echo -e "${RED}❌ Native Server 未构建${NC}"
    echo "   运行: pnpm run build:native"
fi
echo ""

# 4. 检查 Native Messaging Host 配置
echo "4️⃣  检查 Native Messaging Host 配置..."
if [[ "$OSTYPE" == "darwin"* ]]; then
    CONFIG_FILE="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.chromemcp.nativehost.json"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    CONFIG_FILE="$HOME/.config/google-chrome/NativeMessagingHosts/com.chromemcp.nativehost.json"
else
    CONFIG_FILE="未知操作系统"
fi

if [ -f "$CONFIG_FILE" ]; then
    echo -e "${GREEN}✅ 配置文件存在${NC}"
    echo "   路径: $CONFIG_FILE"
    echo ""
    echo "   内容:"
    cat "$CONFIG_FILE" | sed 's/^/   /'
    echo ""

    # 检查配置是否正确
    if grep -q "$PROJECT_ROOT" "$CONFIG_FILE"; then
        echo -e "${GREEN}✅ 路径配置正确${NC}"
    else
        echo -e "${YELLOW}⚠️  路径可能不正确，应包含: $PROJECT_ROOT${NC}"
    fi
else
    echo -e "${RED}❌ 配置文件不存在${NC}"
    echo "   运行: cd app/native-server && node dist/cli.js register"
fi
echo ""

# 5. 检查 Chrome Extension
echo "5️⃣  检查 Chrome Extension..."
if [[ "$OSTYPE" == "darwin"* ]]; then
    EXTENSION_DIR="$HOME/Library/Application Support/Google/Chrome/Default/Extensions"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    EXTENSION_DIR="$HOME/.config/google-chrome/Default/Extensions"
else
    EXTENSION_DIR="未知"
fi

if [ -d "$EXTENSION_DIR" ]; then
    echo "   Extension 目录: $EXTENSION_DIR"
    echo ""
    echo "   已安装的 Extension ID (前10个):"
    ls -1 "$EXTENSION_DIR" 2>/dev/null | head -10 | sed 's/^/   - /'
    echo ""
    echo -e "${YELLOW}💡 请在 chrome://extensions/ 中确认您的 Extension 已加载${NC}"
else
    echo -e "${YELLOW}⚠️  Chrome Extension 目录未找到${NC}"
fi
echo ""

# 6. 检查日志文件
echo "6️⃣  检查日志文件..."
LOG_DIR="$HOME/Library/Logs/mcp-chrome-bridge"
if [ -d "$LOG_DIR" ]; then
    echo "   日志目录: $LOG_DIR"

    LATEST_LOG=$(ls -t "$LOG_DIR"/*.log 2>/dev/null | head -1)
    if [ -n "$LATEST_LOG" ]; then
        echo ""
        echo "   最新日志 (最后30行):"
        tail -30 "$LATEST_LOG" | sed 's/^/   /'
    else
        echo -e "${YELLOW}   ⚠️  没有日志文件（Native Host 可能从未运行）${NC}"
    fi
else
    echo -e "${YELLOW}⚠️  日志目录不存在（Native Host 可能从未运行）${NC}"
fi
echo ""

# 7. 验证脚本
echo "7️⃣  检查可执行脚本..."
RUN_HOST="$PROJECT_ROOT/app/native-server/dist/run_host.sh"
if [ -f "$RUN_HOST" ]; then
    if [ -x "$RUN_HOST" ]; then
        echo -e "${GREEN}✅ run_host.sh 存在且可执行${NC}"
    else
        echo -e "${YELLOW}⚠️  run_host.sh 存在但不可执行${NC}"
        echo "   运行: chmod +x $RUN_HOST"
    fi
else
    echo -e "${RED}❌ run_host.sh 不存在${NC}"
    echo "   运行: pnpm run build:native"
fi
echo ""

echo "===== 诊断完成 ====="
echo ""
echo "💡 常见问题解决方案："
echo ""
echo "1. Extension 无法连接 Native Host"
echo "   - 检查 Extension ID 是否匹配 Native Messaging 配置"
echo "   - 完全重启 Chrome 浏览器 (⌘+Q / Ctrl+Q)"
echo "   - 运行: ./scripts/update-extension-id.sh <YOUR_EXTENSION_ID>"
echo ""
echo "2. 构建失败"
echo "   - 确保 Node.js v22+ 已安装"
echo "   - 运行: pnpm install && pnpm run build"
echo ""
echo "3. Native Messaging 未注册"
echo "   - 运行: cd app/native-server && node dist/cli.js register"
echo ""
echo "📖 详细文档: docs/01-installation-guide.md"
echo ""
