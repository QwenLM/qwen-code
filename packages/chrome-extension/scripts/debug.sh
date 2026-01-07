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

# 检查是否首次安装
if [[ ! -f "$SCRIPT_DIR/.extension-id" ]]; then
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
echo -e "${BLUE}[1/5]${NC} 检查开发环境..."

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

# 第二步：配置 Native Host
echo -e "\n${BLUE}[2/5]${NC} 配置 Native Host..."

MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$MANIFEST_DIR"

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

# 第三步：检查 Qwen CLI
echo -e "\n${BLUE}[3/5]${NC} 检查 Qwen CLI..."

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

# 第四步：启动测试页面
echo -e "\n${BLUE}[4/5]${NC} 启动测试服务器..."

# 创建测试页面
cat > /tmp/qwen-test.html << 'HTML'
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Qwen CLI Chrome Extension 测试页面</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 40px 20px;
        }
        .container {
            max-width: 900px;
            margin: 0 auto;
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            overflow: hidden;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 40px;
            text-align: center;
        }
        .content {
            padding: 40px;
        }
        h1 {
            font-size: 2.5em;
            margin-bottom: 10px;
        }
        .status {
            display: inline-block;
            padding: 5px 15px;
            background: rgba(255,255,255,0.2);
            border-radius: 20px;
            margin-top: 10px;
        }
        .test-section {
            margin: 30px 0;
            padding: 25px;
            background: #f8f9fa;
            border-radius: 10px;
        }
        .test-section h2 {
            color: #667eea;
            margin-bottom: 15px;
        }
        button {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 8px;
            font-size: 16px;
            cursor: pointer;
            margin: 5px;
            transition: transform 0.2s;
        }
        button:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4);
        }
        #console {
            background: #1e1e1e;
            color: #d4d4d4;
            padding: 15px;
            border-radius: 8px;
            font-family: 'SF Mono', Monaco, 'Courier New', monospace;
            font-size: 14px;
            min-height: 150px;
            max-height: 300px;
            overflow-y: auto;
            margin-top: 15px;
        }
        .log-entry {
            margin: 5px 0;
            padding: 5px;
            border-left: 3px solid transparent;
        }
        .log-entry.info { border-left-color: #3b82f6; }
        .log-entry.warn { border-left-color: #f59e0b; color: #fbbf24; }
        .log-entry.error { border-left-color: #ef4444; color: #f87171; }
        .instructions {
            background: #e0e7ff;
            padding: 20px;
            border-radius: 10px;
            margin-top: 20px;
        }
        .instructions h3 {
            color: #4c1d95;
            margin-bottom: 10px;
        }
        .instructions ol {
            margin-left: 20px;
            color: #4c1d95;
        }
        .instructions li {
            margin: 8px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 Qwen CLI Chrome Extension</h1>
            <div class="status">调试环境已就绪</div>
        </div>

        <div class="content">
            <div class="test-section">
                <h2>📝 测试功能</h2>
                <button onclick="testLog()">测试 Console Log</button>
                <button onclick="testError()">测试 Console Error</button>
                <button onclick="testNetwork()">测试网络请求</button>
                <button onclick="testSelection()">测试文本选择</button>
                <div id="console"></div>
            </div>

            <div class="test-section">
                <h2>📄 示例内容</h2>
                <p>这是一段可以被插件提取的示例文本。你可以选择这段文字，然后使用插件的"Send Selected Text"功能。</p>
                <ul style="margin: 15px 0;">
                    <li>列表项 1：Lorem ipsum dolor sit amet</li>
                    <li>列表项 2：Consectetur adipiscing elit</li>
                    <li>列表项 3：Sed do eiusmod tempor incididunt</li>
                </ul>
                <blockquote style="border-left: 4px solid #667eea; padding-left: 15px; margin: 15px 0; color: #666;">
                    "这是一个引用块，可以测试 Markdown 转换功能。"
                </blockquote>
            </div>

            <div class="instructions">
                <h3>🎯 使用说明</h3>
                <ol>
                    <li>点击 Chrome 工具栏中的插件图标</li>
                    <li>点击 "Connect to Qwen CLI" 建立连接</li>
                    <li>如果安装了 Qwen CLI，点击 "Start Qwen CLI"</li>
                    <li>使用各种功能按钮测试插件功能</li>
                    <li>按 F12 打开 DevTools 查看详细日志</li>
                </ol>
            </div>
        </div>
    </div>

    <script>
        const consoleDiv = document.getElementById('console');

        function addLog(message, type = 'info') {
            const entry = document.createElement('div');
            entry.className = 'log-entry ' + type;
            const time = new Date().toLocaleTimeString();
            entry.textContent = `[${time}] ${message}`;
            consoleDiv.appendChild(entry);
            consoleDiv.scrollTop = consoleDiv.scrollHeight;

            // 同时输出到真实 console
            console[type](message);
        }

        function testLog() {
            addLog('这是一条测试日志消息', 'info');
        }

        function testError() {
            addLog('这是一条测试错误消息', 'error');
        }

        function testNetwork() {
            addLog('发起网络请求...', 'info');
            fetch('https://api.github.com/zen')
                .then(res => res.text())
                .then(data => addLog('请求成功: ' + data, 'info'))
                .catch(err => addLog('请求失败: ' + err.message, 'error'));
        }

        function testSelection() {
            const selection = window.getSelection().toString();
            if (selection) {
                addLog('选中的文本: ' + selection, 'info');
            } else {
                addLog('请先选择一些文本', 'warn');
            }
        }

        // 初始化
        addLog('测试页面已加载', 'info');
        addLog('插件调试环境已就绪', 'info');
    </script>
</body>
</html>
HTML

# 启动 Python HTTP 服务器
cd /tmp
python3 -m http.server 3000 > /tmp/test-server.log 2>&1 &
TEST_PID=$!
sleep 1

echo -e "${GREEN}✓${NC} 测试服务器已启动 (http://localhost:3000)"

# 第五步：启动 Chrome
echo -e "\n${BLUE}[5/5]${NC} 启动 Chrome 并加载插件..."

"$CHROME_PATH" \
    --load-extension="$SCRIPT_DIR/../extension" \
    --auto-open-devtools-for-tabs \
    --no-first-run \
    --no-default-browser-check \
    "http://localhost:3000/qwen-test.html" &

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
echo -e "   • 测试页面: ${BLUE}http://localhost:3000/qwen-test.html${NC}"
echo -e "   • 插件: 已加载到工具栏"

if [ "$QWEN_AVAILABLE" = true ]; then
    echo -e "   • Qwen CLI: 可用 (ACP 模式)"
fi

echo ""
echo -e "${CYAN}🔍 调试位置：${NC}"
echo -e "   • 插件日志: Chrome DevTools Console"
echo -e "   • 后台脚本: chrome://extensions → Service Worker"
echo -e "   • Native Host: /tmp/qwen-bridge-host.log"

echo ""
echo -e "${YELLOW}按 Ctrl+C 停止所有服务${NC}"
echo ""

# 清理函数
cleanup() {
    echo -e "\n${YELLOW}正在停止服务...${NC}"

    # 停止进程
    [ ! -z "$TEST_PID" ] && kill $TEST_PID 2>/dev/null

    echo -e "${GREEN}✓${NC} 已停止所有服务"
    exit 0
}

# 捕获中断信号
trap cleanup INT TERM

# 保持运行
while true; do
    sleep 1
done
