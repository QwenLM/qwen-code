#!/bin/bash

echo "Testing MCP stdio server directly..."
echo ""

# Send initialize request
echo '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}},"id":1}' | \
  node /Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/native-server/dist/mcp/mcp-server-stdio.js 2>&1 | head -20

echo ""
echo "If you see a response above, the stdio server is working."
