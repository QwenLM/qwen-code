#!/usr/bin/env bash
# Signs SHA256SUMS with an Ed25519 private key for release integrity verification.
#
# Usage:
#   RELEASE_SIGNING_KEY_PEM=/path/to/key.pem ./scripts/sign-release.sh dist/releases/vX.Y.Z/SHA256SUMS
#
# Output:
#   Creates SHA256SUMS.sig alongside the input file (base64-encoded 64-byte signature).
#
# Key generation (one-time):
#   openssl genpkey -algorithm Ed25519 -out release-signing-key.pem
#   openssl pkey -in release-signing-key.pem -pubout -outform DER | base64
#   # Embed the base64 public key in standalone-update-verify.ts

set -euo pipefail

if [[ -z "${RELEASE_SIGNING_KEY_PEM:-}" ]]; then
    echo "ERROR: RELEASE_SIGNING_KEY_PEM environment variable must point to the Ed25519 private key." >&2
    exit 1
fi

if [[ ! -f "${RELEASE_SIGNING_KEY_PEM}" ]]; then
    echo "ERROR: Key file not found: ${RELEASE_SIGNING_KEY_PEM}" >&2
    exit 1
fi

SHA256SUMS_FILE="${1:-}"
if [[ -z "${SHA256SUMS_FILE}" || ! -f "${SHA256SUMS_FILE}" ]]; then
    echo "Usage: $0 <path/to/SHA256SUMS>" >&2
    exit 1
fi

SIG_FILE="${SHA256SUMS_FILE}.sig"

# openssl pkeyutl -rawin signs raw content with Ed25519, outputs 64-byte signature
openssl pkeyutl -sign -rawin \
    -inkey "${RELEASE_SIGNING_KEY_PEM}" \
    -in "${SHA256SUMS_FILE}" \
    -out /dev/stdout 2>/dev/null | base64 > "${SIG_FILE}"

echo "Signed: ${SIG_FILE}"
echo "Signature (base64): $(cat "${SIG_FILE}")"
