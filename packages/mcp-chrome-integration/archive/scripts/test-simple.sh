#!/bin/bash
export NO_PROXY=127.0.0.1,localhost

echo "Testing chrome_read_page tool call..."
curl -X POST http://127.0.0.1:12306/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: 257181fc-c39e-4207-9fb5-c6bd2706afee" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"chrome_read_page","arguments":{}},"id":3}' \
  --max-time 10 &

CURL_PID=$!
sleep 10
kill $CURL_PID 2>/dev/null
wait $CURL_PID 2>/dev/null
