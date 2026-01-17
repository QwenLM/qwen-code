#!/bin/bash

# 快速启动脚本 - 适用于 macOS/Linux
# 一键启动所有服务进行调试

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 打印带颜色的消息
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[✓]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[!]${NC} $1"
}

print_error() {
    echo -e "${RED}[✗]${NC} $1"
}

# 获取脚本所在目录
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
EXTENSION_DIR="${EXTENSION_OUT_DIR:-"$SCRIPT_DIR/dist/extension"}"
NATIVE_HOST_DIR="$SCRIPT_DIR/native-host"

# 清屏并显示标题
clear
echo "======================================"
echo "  Qwen CLI Chrome Extension - Quick Start"
echo "======================================"
echo ""

# 1. 检查 Chrome 是否安装
print_info "Checking Chrome installation..."

if [[ "$OSTYPE" == "darwin"* ]]; then
    CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    if [[ ! -f "$CHROME_PATH" ]]; then
        CHROME_PATH="/Applications/Chromium.app/Contents/MacOS/Chromium"
    fi
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    CHROME_PATH=$(which google-chrome || which chromium-browser || which chromium || echo "")
fi

if [[ -z "$CHROME_PATH" ]] || [[ ! -f "$CHROME_PATH" ]]; then
    print_error "Chrome not found! Please install Google Chrome first."
    exit 1
fi

print_success "Chrome found: $CHROME_PATH"

# 2. 快速安装 Native Host (如果需要)
print_info "Setting up Native Host..."

if [[ "$OSTYPE" == "darwin"* ]]; then
    MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    MANIFEST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
fi

mkdir -p "$MANIFEST_DIR"

# 创建 manifest
cat > "$MANIFEST_DIR/com.qwen.cli.bridge.json" << EOF
{
  "name": "com.qwen.cli.bridge",
  "description": "Native messaging host for Qwen CLI Chrome Extension",
  "path": "$NATIVE_HOST_DIR/dist/host.js",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://*/",
    "chrome-extension://jniepomhbdkeifkadbfolbcihcmfpfjo/"
  ]
}
EOF

print_success "Native Host configured"

# 3. 检查 Qwen CLI
print_info "Checking Qwen CLI..."

if command -v qwen &> /dev/null; then
    print_success "Qwen CLI is installed"
    QWEN_VERSION=$(qwen --version 2>/dev/null || echo "unknown")
    print_info "Version: $QWEN_VERSION"

    # 尝试启动 Qwen server
    print_info "Starting Qwen server on port 8080..."

    # 检查端口是否被占用
    if lsof -i:8080 &> /dev/null; then
        print_warning "Port 8080 is already in use, skipping Qwen server start"
    else
        # 在后台启动 Qwen server
        nohup qwen server --port 8080 > /tmp/qwen-server.log 2>&1 &
        QWEN_PID=$!
        sleep 2

        if kill -0 $QWEN_PID 2>/dev/null; then
            print_success "Qwen server started (PID: $QWEN_PID)"
            echo $QWEN_PID > /tmp/qwen-server.pid
        else
            print_warning "Failed to start Qwen server, continuing anyway..."
        fi
    fi
else
    print_warning "Qwen CLI not installed - some features will be limited"
fi

# 4. 启动简单的测试服务器
print_info "Starting test server..."

# 创建简单的 Python HTTP 服务器
cat > /tmp/test-server.py << 'EOF'
#!/usr/bin/env python3
import http.server
import socketserver

PORT = 3000

html_content = """
<!DOCTYPE html>
<html>
<head>
    <title>Qwen CLI Chrome Extension Test</title>
    <style>
        body {
            font-family: Arial;
            padding: 40px;
            background: linear-gradient(135deg, #667eea, #764ba2);
            color: white;
        }
        .container {
            background: white;
            color: #333;
            padding: 30px;
            border-radius: 10px;
            max-width: 800px;
            margin: 0 auto;
        }
        h1 { color: #667eea; }
        button {
            background: #667eea;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 5px;
            margin: 5px;
            cursor: pointer;
        }
        button:hover { opacity: 0.9; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 Qwen CLI Chrome Extension Test Page</h1>
        <p>Extension debugging environment is ready!</p>

        <h2>Quick Tests</h2>
        <button onclick="console.log('Test log message')">Test Console Log</button>
        <button onclick="console.error('Test error message')">Test Console Error</button>
        <button onclick="fetch('/api/test').catch(e => console.error(e))">Test Network Request</button>

        <h2>Instructions</h2>
        <ol>
            <li>Click the extension icon in Chrome toolbar</li>
            <li>Click "Connect to Qwen CLI"</li>
            <li>Try the various features</li>
            <li>Open DevTools (F12) to see console output</li>
        </ol>

        <h2>Sample Content</h2>
        <p>This is sample text content that can be extracted by the extension.</p>
        <ul>
            <li>Item 1: Lorem ipsum dolor sit amet</li>
            <li>Item 2: Consectetur adipiscing elit</li>
            <li>Item 3: Sed do eiusmod tempor</li>
        </ul>
    </div>

    <script>
        console.log('Test page loaded successfully');
        console.info('Ready for debugging');
    </script>
</body>
</html>
"""

class MyHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-type', 'text/html')
        self.end_headers()
        self.wfile.write(html_content.encode())

with socketserver.TCPServer(("", PORT), MyHandler) as httpd:
    print(f"Test server running at http://localhost:{PORT}")
    httpd.serve_forever()
EOF

python3 /tmp/test-server.py > /tmp/test-server.log 2>&1 &
TEST_SERVER_PID=$!
echo $TEST_SERVER_PID > /tmp/test-server.pid
sleep 1

print_success "Test server started at http://localhost:3000"

# 5. 启动 Chrome
print_info "Starting Chrome with extension..."

# Ensure extension is built
if [[ ! -d "$EXTENSION_DIR" ]]; then
    echo "Extension output not found at $EXTENSION_DIR"
    echo "Please run: EXTENSION_OUT_DIR=dist/extension npm run build"
    exit 1
fi

# Chrome 参数
CHROME_ARGS=(
    "--load-extension=$EXTENSION_DIR"
    "--auto-open-devtools-for-tabs"
    "--no-first-run"
    "--no-default-browser-check"
    "--disable-default-apps"
    "http://localhost:3000"
)

# 启动 Chrome
"$CHROME_PATH" "${CHROME_ARGS[@]}" &
CHROME_PID=$!

print_success "Chrome started with extension loaded"

# 6. 显示状态和清理指令
echo ""
echo "======================================"
echo "         ✅ All Services Running"
echo "======================================"
echo ""
echo "📌 Chrome: Running (PID: $CHROME_PID)"
echo "📌 Test Page: http://localhost:3000"
if [[ -n "${QWEN_PID:-}" ]]; then
    echo "📌 Qwen Server: http://localhost:8080 (PID: $QWEN_PID)"
fi
echo "📌 Extension: Loaded in Chrome toolbar"
echo ""
echo "📝 Debug Locations:"
echo "   • Extension Logs: Chrome DevTools Console"
echo "   • Background Page: chrome://extensions → Service Worker"
echo "   • Native Host Log: \$HOME/.qwen/chrome-bridge/qwen-bridge-host.log (fallback: /tmp/qwen-bridge-host.log)"
if [[ -n "${QWEN_PID:-}" ]]; then
    echo "   • Qwen Server Log: /tmp/qwen-server.log"
fi
echo ""
echo "🛑 To stop all services, run: $SCRIPT_DIR/stop.sh"
echo "   Or press Ctrl+C to stop this script"
echo ""

# 创建停止脚本
cat > "$SCRIPT_DIR/stop.sh" << 'STOP_SCRIPT'
#!/bin/bash

echo "Stopping services..."

# 停止 Qwen server
if [[ -f /tmp/qwen-server.pid ]]; then
    PID=$(cat /tmp/qwen-server.pid)
    if kill -0 $PID 2>/dev/null; then
        kill $PID
        echo "✓ Qwen server stopped"
    fi
    rm /tmp/qwen-server.pid
fi

# 停止测试服务器
if [[ -f /tmp/test-server.pid ]]; then
    PID=$(cat /tmp/test-server.pid)
    if kill -0 $PID 2>/dev/null; then
        kill $PID
        echo "✓ Test server stopped"
    fi
    rm /tmp/test-server.pid
fi

echo "✓ All services stopped"
STOP_SCRIPT

chmod +x "$SCRIPT_DIR/stop.sh"

# 等待用户中断
trap 'echo "Stopping services..."; $SCRIPT_DIR/stop.sh; exit 0' INT TERM

# 保持脚本运行
while true; do
    sleep 1
done
