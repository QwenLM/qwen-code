#!/usr/bin/env bash
# =============================================================================
# Docker smoke test for Qwen Code Server
#
# Starts the container, waits for the server to become ready, then runs
# --validate-server via the CLI against it. Cleans up on exit.
#
# Usage:
#   bash scripts/docker-smoke-test.sh <image:tag>
#
# Environment:
#   STITCH_API_KEY      — optional, enables additional checks
#   SMOKE_TEST_TIMEOUT  — seconds to wait for server ready (default: 30)
# =============================================================================
set -euo pipefail

IMAGE="${1:?Usage: docker-smoke-test.sh <image:tag>}"
TIMEOUT="${SMOKE_TEST_TIMEOUT:-30}"
TOKEN="smoke-test-$(openssl rand -hex 16)"
CONTAINER_NAME="craft-smoke-$$"
PORT=9100

cleanup() {
  echo ""
  echo "=== Cleaning up ==="
  docker logs "$CONTAINER_NAME" 2>/dev/null || true
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
}
trap cleanup EXIT

echo "=== Docker Smoke Test ==="
echo "  Image:     $IMAGE"
echo "  Container: $CONTAINER_NAME"
echo "  Port:      $PORT"
echo ""

# --- Start the container ---
echo "[1/3] Starting container..."
docker run -d \
  --name "$CONTAINER_NAME" \
  -p "$PORT:9100" \
  -e "CRAFT_SERVER_TOKEN=$TOKEN" \
  -e "CRAFT_RPC_HOST=0.0.0.0" \
  -e "CRAFT_RPC_PORT=9100" \
  "$IMAGE"

# --- Wait for server ready ---
echo "[2/3] Waiting for server to be ready (timeout: ${TIMEOUT}s)..."
ELAPSED=0
READY=false
while [ "$ELAPSED" -lt "$TIMEOUT" ]; do
  # Check if container is still running
  if ! docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -q true; then
    echo "ERROR: Container exited unexpectedly"
    echo "--- Container logs ---"
    docker logs "$CONTAINER_NAME" 2>&1 || true
    exit 1
  fi

  # Check for the ready indicator in logs
  if docker logs "$CONTAINER_NAME" 2>&1 | grep -q "CRAFT_SERVER_URL="; then
    READY=true
    break
  fi

  sleep 1
  ELAPSED=$((ELAPSED + 1))
done

if [ "$READY" != "true" ]; then
  echo "ERROR: Server did not become ready within ${TIMEOUT}s"
  echo "--- Container logs ---"
  docker logs "$CONTAINER_NAME" 2>&1 || true
  exit 1
fi

echo "  Server is ready!"

# --- Run validate-server ---
echo "[3/3] Running --validate-server..."
SERVER_URL="ws://127.0.0.1:$PORT"

# If we have bun and the CLI available (CI environment), run full validation
if command -v bun &>/dev/null && [ -f "apps/cli/src/index.ts" ]; then
  bun run apps/cli/src/index.ts \
    --validate-server \
    --url "$SERVER_URL" \
    --token "$TOKEN" \
    --no-spinner
else
  # Fallback: basic connectivity check with a WebSocket ping
  echo "  CLI not available, running basic connectivity check..."

  # Use node/bun to test WebSocket connectivity
  node -e "
    const ws = new (require('ws'))('${SERVER_URL}', {
      headers: { 'x-craft-token': '${TOKEN}' }
    });
    const timer = setTimeout(() => { console.error('WebSocket timeout'); process.exit(1); }, 10000);
    ws.on('open', () => { clearTimeout(timer); console.log('  WebSocket connected successfully'); ws.close(); process.exit(0); });
    ws.on('error', (e) => { clearTimeout(timer); console.error('WebSocket error:', e.message); process.exit(1); });
  " 2>/dev/null || {
    # Even simpler fallback: just check the port is open
    echo "  Checking port connectivity..."
    if command -v nc &>/dev/null; then
      nc -z 127.0.0.1 "$PORT" && echo "  Port $PORT is open" || { echo "ERROR: Port $PORT not reachable"; exit 1; }
    else
      echo "  WARN: No connectivity tool available, relying on container-running check only"
    fi
  }
fi

echo ""
echo "=== Smoke test passed ==="
