#!/usr/bin/env bash

# Simple wrapper to log invocation and delegate to chrome-browser-mcp
# Helps debug whether Qwen CLI actually spawns the MCP server.

LOG_FILE="/tmp/cbmcp.log"
# Start fresh each invocation
: >"${LOG_FILE}"

{
  echo "---- $(date -Iseconds) ----"
  echo "[wrapper] cwd: $(pwd)"
  echo "[wrapper] argv: $*"
  echo "[wrapper] env BROWSER_MCP_DEBUG=${BROWSER_MCP_DEBUG:-}"
} >>"${LOG_FILE}" 2>&1

/usr/local/bin/node /Users/jinjing/projects/projj/github.com/QwenLM/qwen-code/packages/chrome-extension/native-host/src/browser-mcp-server.js "$@" \
  2>>"${LOG_FILE}"

exit_code=$?
echo "[wrapper] exit code: ${exit_code}" >>"${LOG_FILE}" 2>&1
exit ${exit_code}
