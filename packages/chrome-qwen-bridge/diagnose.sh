#!/bin/bash

echo "🔍 Chrome Qwen Bridge 连接诊断"
echo "==============================="
echo ""

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# 1. 检查 Native Host 配置
echo -e "${BLUE}1. 检查 Native Host 配置${NC}"
NATIVE_HOST_CONFIG="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.qwen.cli.bridge.json"

if [ -f "$NATIVE_HOST_CONFIG" ]; then
    echo -e "${GREEN}✓${NC} Native Host 配置存在"
    echo "  内容:"
    cat "$NATIVE_HOST_CONFIG" | sed 's/^/    /'

    # 检查路径是否正确
    HOST_PATH=$(cat "$NATIVE_HOST_CONFIG" | grep '"path"' | sed 's/.*"path".*:.*"\(.*\)".*/\1/')
    if [ -f "$HOST_PATH" ]; then
        echo -e "${GREEN}✓${NC} Host 文件存在: $HOST_PATH"
        # 检查是否可执行
        if [ -x "$HOST_PATH" ]; then
            echo -e "${GREEN}✓${NC} Host 文件可执行"
        else
            echo -e "${RED}✗${NC} Host 文件不可执行"
            echo "  修复: chmod +x '$HOST_PATH'"
        fi
    else
        echo -e "${RED}✗${NC} Host 文件不存在: $HOST_PATH"
    fi
else
    echo -e "${RED}✗${NC} Native Host 配置不存在"
    echo "  请运行: npm run install:host"
fi
echo ""

# 2. 检查扩展 ID
echo -e "${BLUE}2. 检查扩展 ID${NC}"
if [ -f ".extension-id" ]; then
    SAVED_ID=$(cat .extension-id)
    echo -e "${GREEN}✓${NC} 保存的扩展 ID: $SAVED_ID"

    # 检查配置中的 ID
    if grep -q "$SAVED_ID" "$NATIVE_HOST_CONFIG" 2>/dev/null; then
        echo -e "${GREEN}✓${NC} Native Host 配置包含此 ID"
    else
        if grep -q 'chrome-extension://\*/' "$NATIVE_HOST_CONFIG" 2>/dev/null; then
            echo -e "${YELLOW}⚠${NC} Native Host 使用通配符 (接受所有扩展)"
        else
            echo -e "${RED}✗${NC} Native Host 配置不包含此 ID"
        fi
    fi
else
    echo -e "${YELLOW}⚠${NC} 未保存扩展 ID"
fi
echo ""

# 3. 测试 Native Host
echo -e "${BLUE}3. 测试 Native Host 直接连接${NC}"
if [ -f "$HOST_PATH" ]; then
    # 发送测试消息
    TEST_RESPONSE=$(echo '{"type":"handshake","version":"1.0.0"}' | \
        python3 -c "
import sys, json, struct
msg = sys.stdin.read().strip()
encoded = msg.encode('utf-8')
sys.stdout.buffer.write(struct.pack('<I', len(encoded)))
sys.stdout.buffer.write(encoded)
sys.stdout.flush()
" | "$HOST_PATH" 2>/dev/null | \
        python3 -c "
import sys, struct, json
try:
    length_bytes = sys.stdin.buffer.read(4)
    if length_bytes:
        length = struct.unpack('<I', length_bytes)[0]
        message = sys.stdin.buffer.read(length)
        print(json.loads(message.decode('utf-8')))
except: pass
" 2>/dev/null)

    if [ -n "$TEST_RESPONSE" ]; then
        echo -e "${GREEN}✓${NC} Native Host 响应: $TEST_RESPONSE"
    else
        echo -e "${RED}✗${NC} Native Host 无响应"
    fi
else
    echo -e "${YELLOW}⚠${NC} 跳过测试 (Host 文件不存在)"
fi
echo ""

# 4. 检查日志
echo -e "${BLUE}4. 检查最近的错误日志${NC}"
LOG_FILE="/tmp/qwen-bridge-host.log"
if [ -f "$LOG_FILE" ]; then
    RECENT_ERRORS=$(tail -20 "$LOG_FILE" | grep -i error | tail -3)
    if [ -n "$RECENT_ERRORS" ]; then
        echo -e "${YELLOW}⚠${NC} 最近的错误:"
        echo "$RECENT_ERRORS" | sed 's/^/    /'
    else
        echo -e "${GREEN}✓${NC} 日志中无最近错误"
    fi
else
    echo "  日志文件不存在"
fi
echo ""

# 5. 建议
echo -e "${BLUE}5. 下一步操作建议${NC}"
echo ""
echo "请按以下步骤操作："
echo ""
echo "1. 重新加载扩展:"
echo "   - 打开 chrome://extensions/"
echo "   - 找到 'Qwen CLI Bridge' 扩展"
echo "   - 点击重新加载按钮 (🔄)"
echo ""
echo "2. 查看 Service Worker 日志:"
echo "   - 在扩展卡片上点击 'Service Worker'"
echo "   - 在打开的控制台中查看错误信息"
echo ""
echo "3. 测试连接:"
echo "   - 点击扩展图标"
echo "   - 点击 'Connect to Qwen CLI'"
echo "   - 观察控制台输出"
echo ""
echo "4. 如果仍有问题:"
echo "   - 运行: ./debug-chrome.sh"
echo "   - 这会打开调试控制台帮助诊断"
echo ""

echo "==============================="
echo "诊断完成"