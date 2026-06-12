#!/usr/bin/env bash
# .fork/apply.sh — Apply all fork patches in series order.
#
# Usage:
#   bash .fork/apply.sh                  # stop on first failure
#   bash .fork/apply.sh --continue       # apply remaining patches after failure
#   bash .fork/apply.sh --check          # dry-run: check if patches apply cleanly
#   bash .fork/apply.sh --check-applied  # verify patches are ALREADY applied
#                                        # (reverse dry-run; forward --check always
#                                        # fails on an already-patched tree)
#
# Exit codes:
#   0  all patches applied (or check passed)
#   1  one or more patches failed

set -euo pipefail

FORK_DIR="$(cd "$(dirname "$0")" && pwd)"
SERIES="$FORK_DIR/patches/series"
PATCH_DIR="$FORK_DIR/patches"
MODE="${1:-apply}"

if [ ! -f "$SERIES" ]; then
  echo "❌ series file not found: $SERIES" >&2
  exit 1
fi

APPLIED=0
FAILED=0
FAILED_LIST=()

while IFS= read -r patch; do
  [[ -z "$patch" || "$patch" == \#* ]] && continue
  PATCH_FILE="$PATCH_DIR/$patch"

  if [ ! -f "$PATCH_FILE" ]; then
    echo "MISSING: $patch"
    FAILED=$((FAILED + 1))
    FAILED_LIST+=("$patch (file not found)")
    continue
  fi

  if [ "$MODE" = "--check" ]; then
    if git apply --check "$PATCH_FILE" 2>/dev/null; then
      echo "OK:      $patch ($(wc -l < "$PATCH_FILE" | tr -d ' ') lines)"
    else
      echo "FAIL:    $patch ($(wc -l < "$PATCH_FILE" | tr -d ' ') lines)"
      FAILED=$((FAILED + 1))
      FAILED_LIST+=("$patch")
    fi
    continue
  fi

  # 已应用校验：patch 能干净地反向 apply，说明其全部 hunk 都已存在于工作区
  if [ "$MODE" = "--check-applied" ]; then
    if git apply --reverse --check "$PATCH_FILE" 2>/dev/null; then
      echo "OK:      $patch (already applied)"
    else
      echo "FAIL:    $patch (not fully applied)"
      FAILED=$((FAILED + 1))
      FAILED_LIST+=("$patch")
    fi
    continue
  fi

  if git apply --check "$PATCH_FILE" 2>/dev/null; then
    if git apply "$PATCH_FILE"; then
      echo "APPLIED: $patch"
      APPLIED=$((APPLIED + 1))
    else
      echo "FAILED:  $patch (apply failed after --check passed)"
      FAILED=$((FAILED + 1))
      FAILED_LIST+=("$patch")
    fi
  else
    echo "FAILED:  $patch"
    git apply --reject "$PATCH_FILE" 2>/dev/null || true
    REJ_COUNT=$(find . -name "*.rej" -newer "$PATCH_FILE" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$REJ_COUNT" -gt 0 ]; then
      echo "   $REJ_COUNT .rej file(s) generated. Locations:"
      find . -name "*.rej" -newer "$PATCH_FILE" 2>/dev/null | while read -r f; do echo "     $f"; done
    fi
    FAILED=$((FAILED + 1))
    FAILED_LIST+=("$patch")
    if [ "$MODE" != "--continue" ]; then
      echo ""
      echo "Use --continue to apply remaining patches after fixing .rej files"
      break
    fi
  fi
done < "$SERIES"

echo ""
if [ "$MODE" = "--check" ] || [ "$MODE" = "--check-applied" ]; then
  echo "Check complete: $FAILED failed"
else
  echo "Applied: $APPLIED  Failed: $FAILED"
fi

if [ "$FAILED" -gt 0 ]; then
  echo "Failed patches:"
  for p in "${FAILED_LIST[@]}"; do
    echo "  - $p"
  done
  exit 1
fi
exit 0
