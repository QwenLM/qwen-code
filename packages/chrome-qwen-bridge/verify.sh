#!/bin/bash

# Chrome Qwen Bridge 完整性检查脚本

echo "======================================"
echo "   Chrome Qwen Bridge 健康检查 🏥   "
echo "======================================"
echo ""

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 检查函数
check_file() {
    if [ -f "$1" ]; then
        echo -e "${GREEN}✓${NC} $2"
        return 0
    else
        echo -e "${RED}✗${NC} $2 - 缺失!"
        return 1
    fi
}

check_dir() {
    if [ -d "$1" ]; then
        echo -e "${GREEN}✓${NC} $2"
        return 0
    else
        echo -e "${RED}✗${NC} $2 - 缺失!"
        return 1
    fi
}

# 1. 检查目录结构
echo -e "${BLUE}📂 检查目录结构${NC}"
echo "-------------------"
check_dir "extension" "扩展主目录"
check_dir "extension/background" "后台脚本目录"
check_dir "extension/content" "内容脚本目录"
check_dir "extension/popup" "弹窗目录"
check_dir "extension/options" "选项页目录"
check_dir "extension/icons" "图标目录"
check_dir "native-host" "Native Host 目录"
check_dir "docs" "文档目录"
echo ""

# 2. 检查核心文件
echo -e "${BLUE}📄 检查核心文件${NC}"
echo "-------------------"
ERROR_COUNT=0

# Manifest 文件
if ! check_file "extension/manifest.json" "Manifest V3 配置"; then
    ((ERROR_COUNT++))
fi

# 后台脚本
if ! check_file "extension/background/service-worker.js" "Service Worker"; then
    ((ERROR_COUNT++))
fi

# 内容脚本
if ! check_file "extension/content/content-script.js" "内容脚本"; then
    ((ERROR_COUNT++))
fi

# 弹窗文件
if ! check_file "extension/popup/popup.html" "弹窗 HTML"; then
    ((ERROR_COUNT++))
fi
if ! check_file "extension/popup/popup.js" "弹窗脚本"; then
    ((ERROR_COUNT++))
fi

# 选项页文件
if ! check_file "extension/options/options.html" "选项页 HTML"; then
    ((ERROR_COUNT++))
fi
if ! check_file "extension/options/options.js" "选项页脚本"; then
    ((ERROR_COUNT++))
fi

# Native Host 文件
if ! check_file "native-host/host.js" "Native Host 脚本"; then
    ((ERROR_COUNT++))
fi
if ! check_file "native-host/com.qwen.bridge.json.template" "Native Host 配置模板"; then
    ((ERROR_COUNT++))
fi

echo ""

# 3. 检查 Manifest 配置
echo -e "${BLUE}🔧 检查 Manifest 配置${NC}"
echo "-------------------"
if [ -f "extension/manifest.json" ]; then
    # 检查关键字段
    if grep -q '"manifest_version": 3' extension/manifest.json; then
        echo -e "${GREEN}✓${NC} Manifest V3"
    else
        echo -e "${RED}✗${NC} 不是 Manifest V3"
        ((ERROR_COUNT++))
    fi

    if grep -q '"options_ui"' extension/manifest.json; then
        echo -e "${GREEN}✓${NC} options_ui 配置正确"
    else
        echo -e "${RED}✗${NC} 缺少 options_ui 配置"
        ((ERROR_COUNT++))
    fi

    if grep -q '"nativeMessaging"' extension/manifest.json; then
        echo -e "${GREEN}✓${NC} Native Messaging 权限"
    else
        echo -e "${YELLOW}⚠${NC} 可能缺少 nativeMessaging 权限"
    fi
fi
echo ""

# 4. 检查安装脚本
echo -e "${BLUE}🛠 检查安装脚本${NC}"
echo "-------------------"
check_file "first-install.sh" "首次安装脚本"
check_file "native-host/smart-install.sh" "智能安装脚本"
check_file "debug.sh" "调试脚本"
check_file "test.sh" "测试脚本"
echo ""

# 5. 检查 Native Host 安装状态
echo -e "${BLUE}🔌 检查 Native Host 安装状态${NC}"
echo "-------------------"
NATIVE_HOST_PATH="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.qwen.bridge.json"
if [ -f "$NATIVE_HOST_PATH" ]; then
    echo -e "${GREEN}✓${NC} Native Host 已安装"
    echo "  位置: $NATIVE_HOST_PATH"

    # 检查配置的扩展 ID
    if grep -q "chrome-extension://" "$NATIVE_HOST_PATH"; then
        INSTALLED_ID=$(grep -o 'chrome-extension://[^/]*' "$NATIVE_HOST_PATH" | cut -d'/' -f3)
        echo "  配置的扩展 ID: $INSTALLED_ID"
    fi
else
    echo -e "${YELLOW}⚠${NC} Native Host 未安装"
    echo "  请运行: npm run install:host"
fi
echo ""

# 6. 检查扩展 ID 记录
echo -e "${BLUE}🆔 检查扩展 ID 记录${NC}"
echo "-------------------"
if [ -f ".extension-id" ]; then
    SAVED_ID=$(cat .extension-id)
    echo -e "${GREEN}✓${NC} 已保存扩展 ID: $SAVED_ID"
else
    echo -e "${YELLOW}⚠${NC} 未保存扩展 ID"
    echo "  首次安装后会自动保存"
fi
echo ""

# 7. 检查 Node.js 环境
echo -e "${BLUE}📦 检查 Node.js 环境${NC}"
echo "-------------------"
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    echo -e "${GREEN}✓${NC} Node.js 已安装: $NODE_VERSION"
else
    echo -e "${RED}✗${NC} Node.js 未安装"
    ((ERROR_COUNT++))
fi

if command -v npm &> /dev/null; then
    NPM_VERSION=$(npm --version)
    echo -e "${GREEN}✓${NC} npm 已安装: $NPM_VERSION"
else
    echo -e "${RED}✗${NC} npm 未安装"
    ((ERROR_COUNT++))
fi
echo ""

# 8. 总结
echo "======================================"
if [ $ERROR_COUNT -eq 0 ]; then
    echo -e "${GREEN}✅ 所有检查通过！${NC}"
    echo ""
    echo "下一步操作："
    echo "1. 运行 'npm run dev' 启动调试"
    echo "2. 或运行 './reload.sh' 重新加载扩展"
else
    echo -e "${RED}❌ 发现 $ERROR_COUNT 个问题${NC}"
    echo ""
    echo "建议操作："
    if [ ! -f "$NATIVE_HOST_PATH" ]; then
        echo "• 运行 'npm run install:host' 安装 Native Host"
    fi
    if [ $ERROR_COUNT -gt 0 ]; then
        echo "• 检查上述错误并修复缺失的文件"
    fi
fi
echo "======================================"