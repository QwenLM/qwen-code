#!/bin/bash

echo "🔗 Chrome Extension 连接完整测试"
echo "================================"
echo ""

# 颜色定义
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# 扩展 ID
EXTENSION_ID="cimaabkejokbhjkdnajgfniiolfjgbhd"

# Step 1: 测试 Native Host 直接响应
echo -e "${BLUE}Step 1: 测试 Native Host 直接响应${NC}"
echo "----------------------------------------"

# 创建测试 Python 脚本
cat > /tmp/test_native.py << 'EOF'
#!/usr/bin/env python3
import json
import struct
import subprocess
import sys
import os

def test_native_host():
    host_path = sys.argv[1] if len(sys.argv) > 1 else './native-host/run.sh'

    if not os.path.exists(host_path):
        print(f"❌ Host 文件不存在: {host_path}")
        return False

    try:
        # 启动 Native Host
        proc = subprocess.Popen(
            [host_path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )

        # 发送握手消息
        message = {"type": "handshake", "version": "1.0.0"}
        encoded = json.dumps(message).encode('utf-8')
        proc.stdin.write(struct.pack('<I', len(encoded)))
        proc.stdin.write(encoded)
        proc.stdin.flush()

        # 读取响应
        raw_length = proc.stdout.read(4)
        if raw_length:
            message_length = struct.unpack('<I', raw_length)[0]
            response = proc.stdout.read(message_length)
            result = json.loads(response.decode('utf-8'))
            print(f"✅ Native Host 响应成功")
            print(f"   响应内容: {json.dumps(result, indent=2)}")
            proc.terminate()
            return True
        else:
            print("❌ Native Host 无响应")
            proc.terminate()
            return False

    except Exception as e:
        print(f"❌ 测试失败: {e}")
        return False

if __name__ == "__main__":
    test_native_host()
EOF

chmod +x /tmp/test_native.py
python3 /tmp/test_native.py ./native-host/run.sh
echo ""

# Step 2: 检查 Native Host 配置
echo -e "${BLUE}Step 2: 检查 Native Host 配置${NC}"
echo "----------------------------------------"
CONFIG_FILE="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.qwen.cli.bridge.json"

if [ -f "$CONFIG_FILE" ]; then
    echo -e "${GREEN}✓${NC} 配置文件存在"

    # 检查路径
    PATH_IN_CONFIG=$(grep '"path"' "$CONFIG_FILE" | sed 's/.*"path".*:.*"\(.*\)".*/\1/')
    if [ -f "$PATH_IN_CONFIG" ]; then
        echo -e "${GREEN}✓${NC} 配置的路径有效: $PATH_IN_CONFIG"
    else
        echo -e "${RED}✗${NC} 配置的路径无效: $PATH_IN_CONFIG"
    fi

    # 检查扩展 ID
    if grep -q "chrome-extension://$EXTENSION_ID/" "$CONFIG_FILE"; then
        echo -e "${GREEN}✓${NC} 配置包含正确的扩展 ID"
    elif grep -q 'chrome-extension://\*/' "$CONFIG_FILE"; then
        echo -e "${YELLOW}⚠${NC} 配置使用通配符 (接受所有扩展)"
    else
        echo -e "${RED}✗${NC} 配置不包含扩展 ID"
    fi
else
    echo -e "${RED}✗${NC} 配置文件不存在"
fi
echo ""

# Step 3: 检查 Chrome 进程
echo -e "${BLUE}Step 3: 检查 Chrome 状态${NC}"
echo "----------------------------------------"
if pgrep -x "Google Chrome" > /dev/null; then
    echo -e "${GREEN}✓${NC} Chrome 正在运行"

    # 获取 Chrome 版本
    CHROME_VERSION=$("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --version 2>/dev/null | cut -d' ' -f3)
    if [ -n "$CHROME_VERSION" ]; then
        echo "   版本: $CHROME_VERSION"
    fi
else
    echo -e "${YELLOW}⚠${NC} Chrome 未运行"
fi
echo ""

# Step 4: 提供测试指令
echo -e "${BLUE}Step 4: 手动测试步骤${NC}"
echo "----------------------------------------"
echo "请按以下步骤进行手动测试："
echo ""
echo "1. 打开 Chrome 并访问: chrome://extensions/"
echo "   扩展 ID 应为: ${EXTENSION_ID}"
echo ""
echo "2. 重新加载扩展："
echo "   - 找到 'Qwen CLI Bridge'"
echo "   - 点击重新加载按钮 🔄"
echo ""
echo "3. 查看后台日志："
echo "   - 点击 'Service Worker' 链接"
echo "   - 在控制台中查看日志"
echo ""
echo "4. 测试连接："
echo "   - 点击扩展图标"
echo "   - 点击 'Connect to Qwen CLI'"
echo "   - 观察控制台输出"
echo ""

# Step 5: 提供快速命令
echo -e "${BLUE}Step 5: 快速命令${NC}"
echo "----------------------------------------"
echo "打开扩展管理页面:"
echo -e "${YELLOW}  open 'chrome://extensions/'${NC}"
echo ""
echo "查看 Service Worker:"
echo -e "${YELLOW}  open 'chrome://extensions/?id=$EXTENSION_ID'${NC}"
echo ""
echo "查看 Native Host 日志:"
echo -e "${YELLOW}  tail -f /tmp/qwen-bridge-host.log${NC}"
echo ""

# 清理临时文件
rm -f /tmp/test_native.py

echo "================================"
echo -e "${GREEN}测试完成！${NC}"
echo ""
echo "如果连接仍然失败，请检查 Service Worker 控制台的具体错误信息。"