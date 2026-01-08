#!/bin/bash

# Qwen CLI Chrome Extension - 首次安装脚本

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
EXTENSION_ID_FILE="$ROOT_DIR/.extension-id"

clear
echo -e "${CYAN}╔════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║                                                                ║${NC}"
echo -e "${CYAN}║        🎯 Qwen CLI Chrome Extension - 首次安装向导                      ║${NC}"
echo -e "${CYAN}║                                                                ║${NC}"
echo -e "${CYAN}╚════════════════════════════════════════════════════════════════╝${NC}"
echo ""

echo -e "${YELLOW}这是首次安装，需要手动加载插件到 Chrome。${NC}"
echo ""

# 步骤 1: 配置 Native Host
echo -e "${BLUE}步骤 1:${NC} 配置 Native Host..."

MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$MANIFEST_DIR"

# 先创建一个临时的 manifest，允许所有扩展
cat > "$MANIFEST_DIR/com.qwen.cli.bridge.json" << EOF
{
  "name": "com.qwen.cli.bridge",
  "description": "Native messaging host for Qwen CLI Chrome Extension",
  "path": "$SCRIPT_DIR/../native-host/src/host.js",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://*/"]
}
EOF

echo -e "${GREEN}✓${NC} Native Host 已配置"

# 步骤 2: 打开 Chrome 扩展页面
echo -e "\n${BLUE}步骤 2:${NC} 打开 Chrome 扩展管理页面..."

open -a "Google Chrome" "chrome://extensions"
sleep 2

echo -e "${GREEN}✓${NC} 已打开扩展管理页面"

# 步骤 3: 指导用户安装
echo ""
echo -e "${CYAN}════════════════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}请按照以下步骤手动安装插件：${NC}"
echo ""
echo -e "  1️⃣  在 Chrome 扩展页面，${GREEN}开启「开发者模式」${NC}（右上角开关）"
echo ""
echo -e "  2️⃣  点击 ${GREEN}「加载已解压的扩展程序」${NC} 按钮"
echo ""
echo -e "  3️⃣  选择以下目录："
echo -e "      ${BLUE}$SCRIPT_DIR/../extension${NC}"
echo ""
echo -e "  4️⃣  ${YELLOW}重要：${NC} 记下显示的扩展 ID（类似 ${CYAN}abcdefghijklmnopqrstuvwx${NC}）"
echo ""
echo -e "${CYAN}════════════════════════════════════════════════════════════════${NC}"
echo ""

# 等待用户输入扩展 ID
echo -e "${YELLOW}请输入扩展 ID（安装后显示的 ID）：${NC}"
read -p "> " EXTENSION_ID

if [[ -z "$EXTENSION_ID" ]]; then
    echo -e "${RED}✗ 未输入扩展 ID${NC}"
    echo -e "${YELLOW}你可以稍后手动更新 Native Host 配置${NC}"
else
    # 更新 manifest 文件，添加具体的扩展 ID
    cat > "$MANIFEST_DIR/com.qwen.cli.bridge.json" << EOF
{
  "name": "com.qwen.cli.bridge",
  "description": "Native messaging host for Qwen CLI Chrome Extension",
  "path": "$SCRIPT_DIR/../native-host/src/host.js",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/",
    "chrome-extension://*/"
  ]
}
EOF

    # 保存扩展 ID 供后续使用
    echo "$EXTENSION_ID" > "$EXTENSION_ID_FILE"

    echo -e "${GREEN}✓${NC} Native Host 已更新，支持扩展 ID: $EXTENSION_ID"
fi

echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}                    ✅ 首次安装完成！                           ${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "现在你可以："
echo ""
echo -e "  1. 运行 ${CYAN}npm run dev${NC} 启动调试环境"
echo -e "  2. 点击 Chrome 工具栏的插件图标开始使用"
echo ""
echo -e "${YELLOW}提示：${NC}"
echo -e "  • 如果看不到插件图标，点击拼图图标并固定插件"
echo -e "  • 首次连接可能需要刷新页面"
echo ""

# 询问是否立即启动
echo -e "${CYAN}是否立即启动调试环境？(y/n)${NC}"
read -p "> " START_NOW

if [[ "$START_NOW" == "y" ]] || [[ "$START_NOW" == "Y" ]]; then
    echo -e "\n${GREEN}正在启动调试环境...${NC}\n"
    exec "$SCRIPT_DIR/debug.sh"
fi
