#!/bin/bash

echo "===== MCP Chrome Extension 诊断工具 ====="
echo ""

# 1. 检查 Chrome 插件是否安装
echo "1️⃣  检查 Chrome 插件安装状态..."
EXTENSION_DIR="$HOME/Library/Application Support/Google/Chrome/Default/Extensions"
EXPECTED_ID="mdcjeiebajocdnaiofbdjgadeoommfjh"

if [ -d "$EXTENSION_DIR/$EXPECTED_ID" ]; then
    echo "✅ 插件已安装 (ID: $EXPECTED_ID)"
    ls -la "$EXTENSION_DIR/$EXPECTED_ID/"
else
    echo "❌ 插件未找到 (ID: $EXPECTED_ID)"
    echo "   请检查插件是否已加载，或 ID 是否正确"
    echo ""
    echo "   已安装的插件："
    ls -1 "$EXTENSION_DIR" 2>/dev/null | head -10
fi

echo ""

# 2. 检查 Native Messaging Host 配置
echo "2️⃣  检查 Native Messaging Host 配置..."
CONFIG_FILE="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.chromemcp.nativehost.json"
if [ -f "$CONFIG_FILE" ]; then
    echo "✅ 配置文件存在: $CONFIG_FILE"
    cat "$CONFIG_FILE"
else
    echo "❌ 配置文件不存在"
fi

echo ""

# 3. 检查脚本文件
echo "3️⃣  检查脚本文件..."
SCRIPT_PATH="/Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/native-server/dist/run_host.sh"
if [ -x "$SCRIPT_PATH" ]; then
    echo "✅ 脚本文件存在且可执行: $SCRIPT_PATH"
else
    echo "❌ 脚本文件不存在或不可执行"
fi

echo ""

# 4. 检查 Node.js
echo "4️⃣  检查 Node.js..."
if command -v node &>/dev/null; then
    NODE_VERSION=$(node -v)
    NODE_PATH=$(which node)
    echo "✅ Node.js 已安装: $NODE_VERSION ($NODE_PATH)"
else
    echo "❌ Node.js 未找到"
fi

echo ""

# 5. 检查日志文件
echo "5️⃣  检查日志文件..."
LOG_DIR="$HOME/Library/Logs/mcp-chrome-bridge"
if [ -d "$LOG_DIR" ]; then
    echo "日志目录: $LOG_DIR"
    LATEST_WRAPPER_LOG=$(ls -t "$LOG_DIR"/native_host_wrapper_* 2>/dev/null | head -1)
    LATEST_STDERR_LOG=$(ls -t "$LOG_DIR"/native_host_stderr_* 2>/dev/null | head -1)

    if [ -n "$LATEST_WRAPPER_LOG" ]; then
        echo ""
        echo "📄 最新 wrapper 日志 ($LATEST_WRAPPER_LOG):"
        echo "---"
        tail -30 "$LATEST_WRAPPER_LOG"
    else
        echo "⚠️  没有 wrapper 日志（脚本可能从未被调用）"
    fi

    if [ -n "$LATEST_STDERR_LOG" ]; then
        echo ""
        echo "📄 最新 stderr 日志 ($LATEST_STDERR_LOG):"
        echo "---"
        tail -30 "$LATEST_STDERR_LOG"
    else
        echo "⚠️  没有 stderr 日志"
    fi
else
    echo "⚠️  日志目录不存在（脚本可能从未运行）"
fi

echo ""

# 6. 测试 HTTP 服务器
echo "6️⃣  检查 HTTP 服务器 (端口 12306)..."
if lsof -i :12306 &>/dev/null; then
    echo "✅ HTTP 服务器正在运行"
    lsof -i :12306
else
    echo "❌ HTTP 服务器未运行"
    echo "   提示: 需要先启动 HTTP 服务器"
fi

echo ""
echo "===== 诊断完成 ====="
echo ""
echo "💡 常见问题解决方案："
echo ""
echo "问题 1: 插件 ID 不匹配"
echo "  解决: 在 Chrome 中打开 chrome://extensions/"
echo "        开启开发者模式，找到插件的实际 ID"
echo "        更新配置文件中的 allowed_origins"
echo ""
echo "问题 2: Native Messaging Host 未连接"
echo "  解决: 重启 Chrome 浏览器"
echo "        检查插件是否启用"
echo "        查看上方日志中的错误信息"
echo ""
echo "问题 3: HTTP 服务器未运行"
echo "  解决: 运行以下命令启动服务器:"
echo "        cd /Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/native-server"
echo "        npm start"
echo ""
