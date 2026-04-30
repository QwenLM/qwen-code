#!/bin/sh
# Generate a self-signed TLS certificate for development.
# Usage: ./scripts/generate-dev-cert.sh [output-dir]
#
# Creates cert.pem and key.pem in the specified directory (default: ./certs/).
# These are valid for 365 days and trusted only locally.
#
# To use with the server:
#   CRAFT_RPC_TLS_CERT=certs/cert.pem CRAFT_RPC_TLS_KEY=certs/key.pem bun run server:dev

set -e

OUT_DIR="${1:-certs}"
mkdir -p "$OUT_DIR"

openssl req -x509 \
  -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -keyout "$OUT_DIR/key.pem" \
  -out "$OUT_DIR/cert.pem" \
  -days 365 -nodes \
  -subj "/CN=craft-agent-dev" \
  2>/dev/null

echo "Generated self-signed TLS certificate:"
echo "  cert: $OUT_DIR/cert.pem"
echo "  key:  $OUT_DIR/key.pem"
echo ""
echo "Start server with TLS:"
echo "  CRAFT_RPC_TLS_CERT=$OUT_DIR/cert.pem CRAFT_RPC_TLS_KEY=$OUT_DIR/key.pem bun run server:dev"
