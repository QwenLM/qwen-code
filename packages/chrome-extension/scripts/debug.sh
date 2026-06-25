#!/bin/bash

# Qwen CLI Chrome Extension - macOS 一键调试脚本

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# 获取脚本目录
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
EXTENSION_ID_FILE="$ROOT_DIR/.extension-id"

# 兼容旧路径的 .extension-id（如存在则迁移到统一位置）
if [[ ! -f "$EXTENSION_ID_FILE" ]]; then
    for legacy in "$SCRIPT_DIR/.extension-id" "$SCRIPT_DIR/../native-host/.extension-id"; do
        if [[ -f "$legacy" ]]; then
            cp "$legacy" "$EXTENSION_ID_FILE"
            break
        fi
    done
fi

# 检查是否首次安装
if [[ ! -f "$EXTENSION_ID_FILE" ]]; then
    echo -e "${YELLOW}╔════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${YELLOW}║                                                                ║${NC}"
    echo -e "${YELLOW}║           ⚠️  检测到首次运行，需要先安装插件                   ║${NC}"
    echo -e "${YELLOW}║                                                                ║${NC}"
    echo -e "${YELLOW}╚════════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${CYAN}即将启动首次安装向导...${NC}"
    sleep 2
    exec "$SCRIPT_DIR/first-install.sh"
    exit 0
fi

# 清屏显示标题
clear
echo -e "${CYAN}╔════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║                                                                ║${NC}"
echo -e "${CYAN}║     🚀 Qwen CLI Chrome Extension - macOS 调试环境                      ║${NC}"
echo -e "${CYAN}║                                                                ║${NC}"
echo -e "${CYAN}╚════════════════════════════════════════════════════════════════╝${NC}"
echo ""

# 第一步：检查环境
echo -e "${BLUE}[1/6]${NC} 检查开发环境..."

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}✗${NC} Node.js 未安装，请先安装 Node.js"
    echo "  访问 https://nodejs.org 下载安装"
    exit 1
fi
echo -e "${GREEN}✓${NC} Node.js $(node --version)"

# 检查 Chrome
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [[ ! -f "$CHROME_PATH" ]]; then
    echo -e "${RED}✗${NC} Chrome 未找到"
    exit 1
fi
echo -e "${GREEN}✓${NC} Chrome 已安装"
EXT_DIR="$SCRIPT_DIR/../dist/extension"

# 第二步：配置 Native Host
echo -e "\n${BLUE}[2/6]${NC} 配置 Native Host..."

MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$MANIFEST_DIR"

cat > "$MANIFEST_DIR/com.qwen.cli.bridge.json" << EOF
{
  "name": "com.qwen.cli.bridge",
  "description": "Native messaging host for Qwen CLI Chrome Extension",
  "path": "$SCRIPT_DIR/../native-host/dist/host.js",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://*/"]
}
EOF

echo -e "${GREEN}✓${NC} Native Host 已配置"

# 第三步：检查 Qwen CLI
echo -e "\n${BLUE}[3/6]${NC} 检查 Qwen CLI..."

QWEN_AVAILABLE=false
if command -v qwen &> /dev/null; then
    QWEN_AVAILABLE=true
    QWEN_VERSION=$(qwen --version 2>/dev/null || echo "已安装")
    echo -e "${GREEN}✓${NC} Qwen CLI ${QWEN_VERSION}"
    echo -e "${CYAN}→${NC} 使用 ACP 模式与 Chrome 插件通信"
else
    echo -e "${YELLOW}!${NC} Qwen CLI 未安装（插件基础功能仍可使用）"
    echo -e "   安装方法: npm install -g @anthropic-ai/qwen-code"
fi

# 第四步：构建扩展
echo -e "\n${BLUE}[4/6]${NC} 构建扩展..."
(
  cd "$SCRIPT_DIR/.."
  EXTENSION_OUT_DIR=dist/extension npm run build >/tmp/qwen-bridge-build.log 2>&1
)
if [[ ! -d "$EXT_DIR" ]]; then
    echo -e "${RED}✗${NC} 构建失败，查看 /tmp/qwen-bridge-build.log"
    exit 1
fi
echo -e "${GREEN}✓${NC} 构建完成，输出目录: ${EXT_DIR}"

# 第五步：启动测试页面
# 第五步：启动 Chrome
echo -e "\n${BLUE}[5/5]${NC} 启动 Chrome 并加载插件..."

"$CHROME_PATH" \
    --load-extension="$EXT_DIR" \
    --auto-open-devtools-for-tabs \
    --no-first-run \
    --no-default-browser-check \
    "about:blank" &

CHROME_PID=$!

echo -e "${GREEN}✓${NC} Chrome 已启动"

# 显示最终状态
echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                                                                ║${NC}"
echo -e "${GREEN}║                    ✅ 调试环境启动成功！                       ║${NC}"
echo -e "${GREEN}║                                                                ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${CYAN}📍 服务状态：${NC}"
echo -e "   • Chrome: 运行中"
echo -e "   • 插件: 已加载到工具栏"

if [ "$QWEN_AVAILABLE" = true ]; then
    echo -e "   • Qwen CLI: 可用 (ACP 模式)"
fi

echo ""
echo -e "${CYAN}🔍 调试位置：${NC}"
echo -e "   • 插件日志: Chrome DevTools Console"
echo -e "   • 后台脚本: chrome://extensions → Service Worker"
echo -e "   • Native Host: $HOME/.qwen/chrome-bridge/qwen-bridge-host.log (fallback: /tmp/qwen-bridge-host.log)"

echo ""
echo -e "${YELLOW}按 Ctrl+C 停止所有服务${NC}"
echo ""

# 清理函数
cleanup() {
    echo -e "\n${YELLOW}正在停止服务...${NC}"

    echo -e "${GREEN}✓${NC} 已停止服务"
    exit 0
}

# 捕获中断信号
trap cleanup INT TERM

# 保持运行
while true; do
    sleep 1
done
