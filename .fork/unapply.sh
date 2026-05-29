#!/usr/bin/env bash
# .fork/unapply.sh — Reverse all fork patches (reverse series order).
#
# After running this, the working tree (excluding .fork/ and fork-only files)
# should match upstream exactly. This is the prerequisite for a conflict-free
# upstream merge.
#
# Usage:
#   bash .fork/unapply.sh              # reverse all patches + package identity
#   bash .fork/unapply.sh --check      # dry-run: check if reverse applies cleanly
#
# Exit codes:
#   0  all patches reversed successfully
#   1  one or more patches failed to reverse

set -euo pipefail

FORK_DIR="$(cd "$(dirname "$0")" && pwd)"
SERIES="$FORK_DIR/patches/series"
PATCH_DIR="$FORK_DIR/patches"
MODE="${1:-apply}"

# Step 1: Reverse package identity rewrites
echo "=== Reversing package identity ==="
if [ "$MODE" = "--check" ]; then
  echo "(dry-run: skipping package identity reversal)"
else
  if ! node "$FORK_DIR/rewrite-package-identity.js" --reverse; then
    echo "ERROR: package identity reversal failed" >&2
    exit 1
  fi
fi

# Step 2: Reverse patches in reverse order
if [ ! -f "$SERIES" ]; then
  echo "⚠️ No series file, skipping patch reversal"
  exit 0
fi

echo ""
echo "=== Reversing patches ==="

REVERSED=0
FAILED=0
FAILED_LIST=()

# Read series into array, then iterate in reverse
PATCHES=()
while IFS= read -r patch; do
  [[ -z "$patch" || "$patch" == \#* ]] && continue
  PATCHES+=("$patch")
done < "$SERIES"

for ((i=${#PATCHES[@]}-1; i>=0; i--)); do
  patch="${PATCHES[$i]}"
  PATCH_FILE="$PATCH_DIR/$patch"

  if [ ! -f "$PATCH_FILE" ]; then
    echo "SKIP:     $patch (file not found)"
    continue
  fi

  if [ "$MODE" = "--check" ]; then
    if git apply --check --reverse "$PATCH_FILE" 2>/dev/null; then
      echo "OK:       $patch"
    else
      echo "FAIL:     $patch"
      FAILED=$((FAILED + 1))
      FAILED_LIST+=("$patch")
    fi
    continue
  fi

  if git apply --reverse "$PATCH_FILE" 2>/dev/null; then
    echo "REVERSED: $patch"
    REVERSED=$((REVERSED + 1))
  else
    echo "FAILED:   $patch (may already be unapplied)"
    FAILED=$((FAILED + 1))
    FAILED_LIST+=("$patch")
  fi
done

echo ""
if [ "$MODE" = "--check" ]; then
  echo "Check complete: $FAILED failed"
else
  echo "Reversed: $REVERSED  Failed: $FAILED"
fi

if [ "$FAILED" -gt 0 ]; then
  echo "Failed patches:"
  for p in "${FAILED_LIST[@]}"; do
    echo "  - $p"
  done
  exit 1
fi
exit 0
