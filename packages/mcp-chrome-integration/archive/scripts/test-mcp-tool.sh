#!/bin/bash

# Test MCP Chrome tool call

# Ensure no proxy for localhost
export NO_PROXY=127.0.0.1,localhost

echo "Step 1: Initialize MCP session..."
INIT_RESPONSE=$(curl -s -i -X POST http://127.0.0.1:12306/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}},"id":1}')

# Extract session ID from response headers
SESSION_ID=$(echo "$INIT_RESPONSE" | grep -i "mcp-session-id:" | awk '{print $2}' | tr -d '\r')

if [ -z "$SESSION_ID" ]; then
  echo "❌ Failed to get session ID"
  echo "Response:"
  echo "$INIT_RESPONSE"
  exit 1
fi

echo "✓ Got session ID: $SESSION_ID"

echo ""
echo "Step 2: Call chrome_read_page tool..."
TOOL_RESPONSE=$(curl -s -X POST http://127.0.0.1:12306/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION_ID" \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{\"name\":\"chrome_read_page\",\"arguments\":{}},\"id\":3}" \
  --max-time 30)

echo "Response:"
echo "$TOOL_RESPONSE"

# Check if response contains error
if echo "$TOOL_RESPONSE" | grep -q '"error"'; then
  echo ""
  echo "❌ Tool call failed"
  exit 1
elif echo "$TOOL_RESPONSE" | grep -q '"result"'; then
  echo ""
  echo "✓ Tool call succeeded!"
  exit 0
else
  echo ""
  echo "⚠️  Unexpected response format"
  exit 1
fi
