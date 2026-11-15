#!/usr/bin/env bash
set -euo pipefail

: "${QWEN_DESKTOP_PATCHELF:?QWEN_DESKTOP_PATCHELF must point to the real patchelf executable}"

# The staged runtime is already executable and checksummed. Rewriting its ELF
# files invalidates those checksums and corrupts the static-PIE x64 ripgrep.
if [[ "$#" -eq 3 && "$1" == '--set-rpath' && "$3" == */runtime/qwen-code/* ]]; then
  if [[ ! -f "$3" ]]; then
    echo "Runtime ELF is missing: $3" >&2
    exit 1
  fi
  echo "patchelf-immutable-runtime: skipped $1 on $3" >&2
  exit 0
fi

exec "$QWEN_DESKTOP_PATCHELF" "$@"
