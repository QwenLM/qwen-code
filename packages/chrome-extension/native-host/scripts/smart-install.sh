#!/bin/bash

# Qwen CLI Chrome Extension - 智能 Native Host 安装器
# 自动检测 Chrome 插件并配置 Native Host

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
HOST_NAME="com.qwen.cli.bridge"
HOST_SCRIPT="$SCRIPT_DIR/../host.js"

echo -e "${CYAN}╔════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║                                                                ║${NC}"
echo -e "${CYAN}║        🔧 Qwen CLI Chrome Extension - Native Host 安装器                ║${NC}"
echo -e "${CYAN}║                                                                ║${NC}"
echo -e "${CYAN}╚════════════════════════════════════════════════════════════════╝${NC}"
echo ""

# 检测操作系统
if [[ "$OSTYPE" == "darwin"* ]]; then
    OS="macOS"
    MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    EXTENSIONS_DIR="$HOME/Library/Application Support/Google/Chrome/Default/Extensions"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    OS="Linux"
    MANIFEST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
    EXTENSIONS_DIR="$HOME/.config/google-chrome/Default/Extensions"
else
    echo -e "${RED}✗ 不支持的操作系统${NC}"
    exit 1
fi

echo -e "${BLUE}检测到系统：${NC} $OS"
echo ""

# 检查 Node.js
echo -e "${BLUE}检查依赖...${NC}"
if ! command -v node &> /dev/null; then
    echo -e "${RED}✗ Node.js 未安装${NC}"
    echo -e "  请访问 https://nodejs.org 安装 Node.js"
    exit 1
fi
echo -e "${GREEN}✓${NC} Node.js $(node --version)"

# 尝试自动检测扩展 ID
echo -e "\n${BLUE}查找已安装的 Qwen CLI Chrome Extension 扩展...${NC}"

EXTENSION_ID=""
AUTO_DETECTED=false

# 方法1: 从 Chrome 扩展目录查找
if [[ -d "$EXTENSIONS_DIR" ]]; then
    for ext_id in "$EXTENSIONS_DIR"/*; do
        if [[ -d "$ext_id" ]]; then
            ext_id_name=$(basename "$ext_id")
            # 检查最新版本目录
            for version_dir in "$ext_id"/*; do
                if [[ -f "$version_dir/manifest.json" ]]; then
                    # 检查是否是我们的扩展
                    if grep -q "Qwen CLI Chrome Extension" "$version_dir/manifest.json" 2>/dev/null; then
                        EXTENSION_ID="$ext_id_name"
                        AUTO_DETECTED=true
                        echo -e "${GREEN}✓${NC} 自动检测到扩展 ID: ${CYAN}$EXTENSION_ID${NC}"
                        break 2
                    fi
                fi
            done
        fi
    done
fi

# 方法2: 检查之前保存的 ID
if [[ -z "$EXTENSION_ID" && -f "$SCRIPT_DIR/../.extension-id" ]]; then
    EXTENSION_ID=$(cat "$SCRIPT_DIR/../.extension-id")
    echo -e "${GREEN}✓${NC} 使用保存的扩展 ID: ${CYAN}$EXTENSION_ID${NC}"
    AUTO_DETECTED=true
fi

# 如果自动检测失败，提供选项
if [[ -z "$EXTENSION_ID" ]]; then
    echo -e "${YELLOW}⚠️  未能自动检测到扩展${NC}"
    echo ""
    echo -e "请选择："
    echo -e "  ${CYAN}1)${NC} 我已经安装了扩展（输入扩展 ID）"
    echo -e "  ${CYAN}2)${NC} 我还没有安装扩展（通用配置）"
    echo -e "  ${CYAN}3)${NC} 打开 Chrome 扩展页面查看"
    echo ""
    read -p "选择 (1/2/3): " CHOICE

    case $CHOICE in
        1)
            echo ""
            echo -e "${YELLOW}请输入扩展 ID:${NC}"
            echo -e "${CYAN}提示: 在 chrome://extensions 页面找到 Qwen CLI Chrome Extension，ID 在扩展卡片上${NC}"
            read -p "> " EXTENSION_ID
            if [[ -n "$EXTENSION_ID" ]]; then
                # 保存 ID 供以后使用
                echo "$EXTENSION_ID" > "$SCRIPT_DIR/../.extension-id"
                echo -e "${GREEN}✓${NC} 扩展 ID 已保存"
            fi
            ;;
        2)
            echo -e "\n${CYAN}将使用通用配置（允许所有开发扩展）${NC}"
            EXTENSION_ID="*"
            ;;
        3)
            echo -e "\n${CYAN}正在打开 Chrome 扩展页面...${NC}"
            open "chrome://extensions" 2>/dev/null || xdg-open "chrome://extensions" 2>/dev/null || echo "请手动打开 chrome://extensions"
            echo ""
            echo -e "${YELLOW}找到 Qwen CLI Chrome Extension 扩展后，输入其 ID:${NC}"
            read -p "> " EXTENSION_ID
            if [[ -n "$EXTENSION_ID" && "$EXTENSION_ID" != "*" ]]; then
                echo "$EXTENSION_ID" > "$SCRIPT_DIR/../.extension-id"
            fi
            ;;
        *)
            echo -e "${RED}无效的选择${NC}"
            exit 1
            ;;
    esac
fi

# 创建 Native Host 目录
echo -e "\n${BLUE}配置 Native Host...${NC}"
mkdir -p "$MANIFEST_DIR"

# 创建 manifest 文件
MANIFEST_FILE="$MANIFEST_DIR/$HOST_NAME.json"

if [[ "$EXTENSION_ID" == "*" ]]; then
    # 通用配置
    cat > "$MANIFEST_FILE" << EOF
{
  "name": "$HOST_NAME",
  "description": "Native messaging host for Qwen CLI Chrome Extension",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://*/"
  ]
}
EOF
    echo -e "${GREEN}✓${NC} Native Host 已配置（通用模式）"
else
    # 特定扩展 ID 配置
    cat > "$MANIFEST_FILE" << EOF
{
  "name": "$HOST_NAME",
  "description": "Native messaging host for Qwen CLI Chrome Extension",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/",
    "chrome-extension://*/"
  ]
}
EOF
    echo -e "${GREEN}✓${NC} Native Host 已配置（扩展 ID: $EXTENSION_ID）"
fi

# 验证配置
echo -e "\n${BLUE}验证配置...${NC}"

# 检查 host.js 是否存在
if [[ ! -f "$HOST_SCRIPT" ]]; then
    echo -e "${RED}✗ host.js 文件不存在${NC}"
    exit 1
fi

# 确保 host.js 可执行
chmod +x "$HOST_SCRIPT"
echo -e "${GREEN}✓${NC} host.js 已设置为可执行"

# 检查 manifest 文件
if [[ -f "$MANIFEST_FILE" ]]; then
    echo -e "${GREEN}✓${NC} Manifest 文件已创建: $MANIFEST_FILE"
else
    echo -e "${RED}✗ Manifest 文件创建失败${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                                                                ║${NC}"
echo -e "${GREEN}║                  ✅ Native Host 安装成功！                     ║${NC}"
echo -e "${GREEN}║                                                                ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════════╝${NC}"
echo ""

# 显示下一步
if [[ "$AUTO_DETECTED" == true ]]; then
    echo -e "${CYAN}检测到扩展已安装，你可以直接使用了！${NC}"
    echo ""
    echo -e "使用方法："
    echo -e "  1. 点击 Chrome 工具栏的扩展图标"
    echo -e "  2. 点击 'Connect to Qwen CLI'"
    echo -e "  3. 开始使用各项功能"
else
    echo -e "${YELLOW}下一步：${NC}"
    echo -e "  1. 在 Chrome 中打开 ${CYAN}chrome://extensions/${NC}"
    echo -e "  2. 开启${CYAN}「开发者模式」${NC}（右上角）"
    echo -e "  3. 点击${CYAN}「加载已解压的扩展程序」${NC}"
    echo -e "  4. 选择目录: ${CYAN}$SCRIPT_DIR/../extension${NC}"
    echo -e "  5. 安装完成后，重新运行此脚本以更新配置"
fi

echo ""
echo -e "${CYAN}提示：${NC}"
echo -e "  • 如需重新配置，随时可以重新运行此脚本"
echo -e "  • 日志文件位置: /tmp/qwen-bridge-host.log"
echo -e "  • 如遇问题，请查看: $SCRIPT_DIR/../docs/debugging.md"
echo ""

# 询问是否测试连接
if [[ "$AUTO_DETECTED" == true ]]; then
    echo -e "${CYAN}是否测试 Native Host 连接？(y/n)${NC}"
    read -p "> " TEST_CONNECTION

    if [[ "$TEST_CONNECTION" == "y" ]] || [[ "$TEST_CONNECTION" == "Y" ]]; then
        echo -e "\n${BLUE}测试连接...${NC}"

        # 创建测试脚本
        cat > /tmp/test-native-host.js << 'EOF'
const chrome = {
  runtime: {
    connectNative: () => {
      console.log("Chrome API not available in Node.js environment");
      console.log("请在 Chrome 扩展中测试连接");
    }
  }
};

// 直接测试 host.js
const { spawn } = require('child_process');
const path = require('path');

const hostPath = process.argv[2];
if (!hostPath) {
  console.error("Missing host path");
  process.exit(1);
}

console.log("Testing host at:", hostPath);

const host = spawn('node', [hostPath], {
  stdio: ['pipe', 'pipe', 'pipe']
});

// 发送测试消息
const testMessage = JSON.stringify({ type: 'handshake', version: '1.0.0' });
const length = Buffer.allocUnsafe(4);
length.writeUInt32LE(Buffer.byteLength(testMessage), 0);

host.stdin.write(length);
host.stdin.write(testMessage);

// 读取响应
let responseBuffer = Buffer.alloc(0);
let messageLength = null;

host.stdout.on('data', (data) => {
  responseBuffer = Buffer.concat([responseBuffer, data]);

  if (messageLength === null && responseBuffer.length >= 4) {
    messageLength = responseBuffer.readUInt32LE(0);
    responseBuffer = responseBuffer.slice(4);
  }

  if (messageLength !== null && responseBuffer.length >= messageLength) {
    const message = JSON.parse(responseBuffer.slice(0, messageLength).toString());
    console.log("Response received:", message);

    if (message.type === 'handshake_response') {
      console.log("✅ Native Host 响应正常");
    }

    host.kill();
    process.exit(0);
  }
});

host.on('error', (error) => {
  console.error("❌ Host error:", error.message);
  process.exit(1);
});

setTimeout(() => {
  console.error("❌ 测试超时");
  host.kill();
  process.exit(1);
}, 5000);
EOF

        node /tmp/test-native-host.js "$HOST_SCRIPT"
        rm /tmp/test-native-host.js
    fi
fi

echo -e "${GREEN}安装完成！${NC}"
