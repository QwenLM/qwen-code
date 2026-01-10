#!/usr/bin/env bash
set -euo pipefail

# Simple daemon runner for qwen-bridge-host (HTTP 127.0.0.1:18765)
# Usage: ./scripts/run-daemon.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

LOG_DIR="${HOME}/.qwen/chrome-bridge"
LOG_FILE="${LOG_DIR}/qwen-bridge-host.log"
mkdir -p "$LOG_DIR"

NODE_BIN="${NODE_BIN:-node}"
HOST_ENTRY="${HOST_ENTRY:-$ROOT_DIR/host.js}"

echo "Starting qwen-bridge-host via $NODE_BIN $HOST_ENTRY"
echo "Logs: $LOG_FILE"

QWEN_BRIDGE_NO_STDIO_EXIT=1 QWEN_BRIDGE_NO_STDIO_STAYALIVE=1 nohup "$NODE_BIN" "$HOST_ENTRY" >> "$LOG_FILE" 2>&1 &
echo $! > "$LOG_DIR/qwen-bridge-host.pid"
echo "Started with PID $(cat "$LOG_DIR/qwen-bridge-host.pid")"
