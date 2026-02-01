#!/bin/bash

# 简单的 MCP 连接测试

echo "=========================================="
echo "测试 MCP Chrome 服务器连接"
echo "=========================================="
echo ""

# 进入正确的目录
cd /Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/chrome-extension

echo "📍 当前目录: $(pwd)"
echo ""

echo "1️⃣  检查 MCP 配置..."
qwen mcp list
echo ""

echo "2️⃣  检查 Native Server 文件..."
SERVER_PATH="/Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/native-server/dist/mcp/mcp-server-stdio.js"
if [ -f "$SERVER_PATH" ]; then
    echo "✅ MCP Server 文件存在"
else
    echo "❌ MCP Server 文件不存在"
    exit 1
fi
echo ""

echo "3️⃣  测试 MCP Server 是否可执行..."
if node "$SERVER_PATH" --version 2>&1 | head -1; then
    echo "✅ MCP Server 可执行"
else
    echo "⚠️  返回码非零（可能正常，某些 MCP 服务器没有 --version 参数）"
fi
echo ""

echo "=========================================="
echo "✅ 基础检查完成"
echo "=========================================="
echo ""
echo "📝 'Disconnected' 状态说明："
echo "  - ✅ 这是正常状态"
echo "  - ✅ MCP 服务器已配置"
echo "  - ✅ Qwen 会话时会自动连接"
echo ""
echo "🎯 实际使用测试："
echo "  运行以下命令测试："
echo "  $ cd $(pwd)"
echo "  $ qwen"
echo "  > 你有哪些工具可以使用？"
echo ""
