#!/usr/bin/env bash
# .fork/verify-patches.sh — Verify that fork patches are applied in the working tree.
#
# Unlike apply.sh --check (which tests if a patch CAN be applied, meaning it is
# NOT present), this script checks whether each patch's added content IS present
# in the current working tree.
#
# For each patch in the series:
#   1. Extract added lines (12+ chars after trimming whitespace)
#   2. Check if those lines exist in the target files
#   3. Report match rate: PASS (≥80%), WARN (≥50%), FAIL (<50%)
#
# Exit codes:
#   0  all patches PASS or WARN (no FAIL)
#   1  one or more patches FAIL (content missing from working tree)
#   2  environment error (series file missing, etc.)
#
# Usage:
#   bash .fork/verify-patches.sh            # normal run
#   bash .fork/verify-patches.sh --verbose  # show PASS/SKIP details

set -uo pipefail

FORK_DIR="$(cd "$(dirname "$0")" && pwd)"
SERIES="$FORK_DIR/patches/series"
PATCH_DIR="$FORK_DIR/patches"
VERBOSE="${1:-}"

PASS_THRESHOLD=80
WARN_THRESHOLD=50
MIN_LINE_LENGTH=12

if [ ! -f "$SERIES" ]; then
  echo "❌ series file not found: $SERIES" >&2
  exit 2
fi

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
FAIL_LIST=()

while IFS= read -r patch_name; do
  [[ -z "$patch_name" || "$patch_name" == \#* ]] && continue
  PATCH_FILE="$PATCH_DIR/$patch_name"

  if [ ! -f "$PATCH_FILE" ]; then
    echo "MISSING: $patch_name"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAIL_LIST+=("$patch_name (file not found)")
    continue
  fi

  total=0
  matched=0
  current_file=""

  while IFS= read -r line; do
    case "$line" in
      "+++ /dev/null")
        current_file=""
        ;;
      "+++ b/"*)
        current_file="${line#+++ b/}"
        # Skip lockfiles, snapshots, build artifacts
        case "$current_file" in
          *package-lock.json|*pnpm-lock.yaml|*yarn.lock|*.lock|\
          *.snap|*.snap.txt|*/dist/*|*/build/*)
            current_file=""
            ;;
        esac
        ;;
      "+++ "*)
        ;;
      "+"*)
        [ -z "$current_file" ] && continue
        # Skip diff metadata lines
        [[ "$line" == "+++"* ]] && continue
        content="${line#+}"
        # Trim leading/trailing whitespace
        content_trimmed="$(printf '%s' "$content" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
        if [ "${#content_trimmed}" -lt "$MIN_LINE_LENGTH" ]; then
          continue
        fi
        total=$((total + 1))
        if [ -f "$current_file" ] && grep -qF -- "$content_trimmed" "$current_file" 2>/dev/null; then
          matched=$((matched + 1))
        fi
        ;;
    esac
  done < "$PATCH_FILE"

  if [ "$total" -eq 0 ]; then
    SKIP_COUNT=$((SKIP_COUNT + 1))
    [ "$VERBOSE" = "--verbose" ] && printf 'SKIP  %s  (no signature lines)\n' "$patch_name"
    continue
  fi

  rate=$((matched * 100 / total))
  if [ "$rate" -ge "$PASS_THRESHOLD" ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    [ "$VERBOSE" = "--verbose" ] && printf 'PASS  %s  (%d/%d, %d%%)\n' "$patch_name" "$matched" "$total" "$rate"
  elif [ "$rate" -ge "$WARN_THRESHOLD" ]; then
    WARN_COUNT=$((WARN_COUNT + 1))
    printf 'WARN  %s  (%d/%d, %d%%)\n' "$patch_name" "$matched" "$total" "$rate"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAIL_LIST+=("$patch_name ($matched/$total, $rate%)")
    printf 'FAIL  %s  (%d/%d, %d%%)\n' "$patch_name" "$matched" "$total" "$rate"
  fi
done < "$SERIES"

echo ""
echo "======== Fork Patch Content Verify ========"
printf 'PASS: %d  |  WARN: %d  |  FAIL: %d  |  SKIP: %d\n' \
  "$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT" "$SKIP_COUNT"

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo ""
  echo "❌ ${FAIL_COUNT} patch(es) missing from working tree:"
  for entry in "${FAIL_LIST[@]}"; do
    echo "  - $entry"
  done
  exit 1
fi

echo "✅ All patches verified"
exit 0
