#!/usr/bin/env bash
# install-server.sh — Set up the Craft Agent standalone server.
#
# Usage:
#   bash scripts/install-server.sh
#
# Prerequisites: Bun >= 1.0
# What it does:
#   1. Checks Bun is installed
#   2. Installs dependencies
#   3. Generates a server token
#   4. Prints the run command

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[info]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $*"; }
error() { echo -e "${RED}[error]${NC} $*" >&2; }

# ---------------------------------------------------------------------------
# Prereqs
# ---------------------------------------------------------------------------

if ! command -v bun &>/dev/null; then
  error "Bun is required but not installed."
  echo "  Install: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

BUN_VERSION=$(bun --version 2>/dev/null || echo "0.0.0")
info "Bun $BUN_VERSION detected"

# ---------------------------------------------------------------------------
# Find repo root
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ ! -f "$REPO_ROOT/packages/server/package.json" ]; then
  error "Cannot find packages/server/package.json. Run this from the repo root or scripts/ dir."
  exit 1
fi

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------

info "Installing dependencies..."
cd "$REPO_ROOT"
bun install --frozen-lockfile 2>/dev/null || bun install

info "Building subprocess servers..."
bun run server:build:subprocess

info "Building Web UI..."
bun run webui:build

# ---------------------------------------------------------------------------
# Generate token
# ---------------------------------------------------------------------------

TOKEN=$(bun run "$REPO_ROOT/packages/server/src/index.ts" --generate-token)
info "Generated server token"

# ---------------------------------------------------------------------------
# Print run command
# ---------------------------------------------------------------------------

echo ""
echo "===================================="
echo "  Craft Agent Server Ready"
echo "===================================="
echo ""
echo "Start the server (with Web UI):"
echo ""
echo "  CRAFT_SERVER_TOKEN=$TOKEN \\"
echo "  CRAFT_WEBUI_DIR=$REPO_ROOT/apps/webui/dist \\"
echo "  CRAFT_BUNDLED_ASSETS_ROOT=$REPO_ROOT/apps/electron \\"
echo "  bun run $REPO_ROOT/packages/server/src/index.ts"
echo ""
echo "Or with custom host/port:"
echo ""
echo "  CRAFT_SERVER_TOKEN=$TOKEN \\"
echo "  CRAFT_WEBUI_DIR=$REPO_ROOT/apps/webui/dist \\"
echo "  CRAFT_BUNDLED_ASSETS_ROOT=$REPO_ROOT/apps/electron \\"
echo "  CRAFT_RPC_HOST=0.0.0.0 \\"
echo "  CRAFT_RPC_PORT=9100 \\"
echo "  bun run $REPO_ROOT/packages/server/src/index.ts"
echo ""
echo "For TLS (recommended for non-localhost):"
echo ""
echo "  CRAFT_SERVER_TOKEN=$TOKEN \\"
echo "  CRAFT_WEBUI_DIR=$REPO_ROOT/apps/webui/dist \\"
echo "  CRAFT_BUNDLED_ASSETS_ROOT=$REPO_ROOT/apps/electron \\"
echo "  CRAFT_RPC_TLS_CERT=/path/to/cert.pem \\"
echo "  CRAFT_RPC_TLS_KEY=/path/to/key.pem \\"
echo "  bun run $REPO_ROOT/packages/server/src/index.ts"
echo ""
warn "Save your token — it cannot be recovered."
echo ""
