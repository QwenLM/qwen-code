#!/bin/bash

echo "Step 1: Initialize MCP stdio server..."
echo '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}},"id":1}'

echo ""
echo "Step 2: List tools..."
echo '{"jsonrpc":"2.0","method":"tools/list","id":2}'

echo ""
echo "Step 3: Call chrome_read_page..."
echo '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"chrome_read_page","arguments":{}},"id":3}'

echo ""
echo "---"
echo "Now piping to stdio server..."
echo ""

{
  echo '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}},"id":1}'
  sleep 1
  echo '{"jsonrpc":"2.0","method":"tools/list","id":2}'
  sleep 1
  echo '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"chrome_read_page","arguments":{}},"id":3}'
  sleep 10
} | node /Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/native-server/dist/mcp/mcp-server-stdio.js 2>&1
