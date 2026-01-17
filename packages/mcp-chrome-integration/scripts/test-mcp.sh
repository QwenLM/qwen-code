#!/bin/bash

# MCP Chrome Integration 测试脚本
# 测试 Qwen CLI 与 Native Server 的集成

echo "=========================================="
echo "MCP Chrome Integration 测试"
echo "=========================================="
echo ""

# 1. 检查 MCP 配置
echo "1️⃣  检查 MCP 配置..."
echo ""
qwen mcp list
echo ""

# 2. 检查 Native Server 文件
echo "2️⃣  检查 Native Server..."
echo ""
SERVER_PATH="/Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/native-server/dist/index.js"
if [ -f "$SERVER_PATH" ]; then
    echo "✅ Native Server 文件存在: $SERVER_PATH"
else
    echo "❌ Native Server 文件不存在"
    exit 1
fi
echo ""

# 3. 测试 Native Server 启动
echo "3️⃣  测试 Native Server 启动..."
echo ""
cd /Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/native-server

# 启动服务器（后台）
node dist/index.js > /tmp/mcp-server-test.log 2>&1 &
SERVER_PID=$!
echo "启动 Native Server (PID: $SERVER_PID)"

# 等待 3 秒
sleep 3

# 检查进程是否还在运行
if ps -p $SERVER_PID > /dev/null 2>&1; then
    echo "✅ Native Server 正在运行"
    echo ""
    echo "服务器日志 (前 20 行):"
    echo "---"
    head -20 /tmp/mcp-server-test.log
    echo "---"

    # 停止服务器
    kill $SERVER_PID 2>/dev/null
    echo ""
    echo "✅ Native Server 已停止"
else
    echo "❌ Native Server 启动失败"
    echo ""
    echo "错误日志:"
    cat /tmp/mcp-server-test.log
    exit 1
fi
echo ""

# 4. 测试 Qwen MCP 调用（需要手动测试）
echo "4️⃣  手动测试步骤："
echo ""
echo "由于 MCP 服务器是按需启动的，请手动测试："
echo ""
echo "方式 1: 在 Qwen 会话中直接使用"
echo "  $ qwen"
echo "  > 请列出当前打开的 Chrome 标签页"
echo ""
echo "方式 2: 使用特定工具（如果支持）"
echo "  $ qwen --tools chrome"
echo ""
echo "方式 3: 检查项目配置"
echo "  $ cat .qwen/settings.json"
echo ""

echo "=========================================="
echo "✅ 基础测试完成"
echo "=========================================="
echo ""
echo "📝 下一步："
echo "  1. Native Server 可以正常启动 ✅"
echo "  2. MCP 配置已添加到 Qwen CLI ✅"
echo "  3. 需要在实际会话中测试 MCP 调用"
echo ""
echo "💡 提示："
echo "  - 'Disconnected' 状态是正常的"
echo "  - MCP 服务器会在需要时自动启动"
echo "  - 确保 Chrome Extension 已加载（如果要测试浏览器工具）"
echo ""
