#!/usr/bin/env bash
# .fork/refresh-patch.sh — Regenerate a patch from the current working tree.
#
# Usage:
#   bash .fork/refresh-patch.sh 0001-branding-header
#   bash .fork/refresh-patch.sh 0001                    # prefix match
#   bash .fork/refresh-patch.sh branding-header          # substring match
#
# Environment:
#   UPSTREAM_REF     default upstream/main
#   FORK_REF         optional committed fork ref to diff, for example origin/main
#   PATCH_BASE_REF   optional explicit base; defaults to merge-base(FORK_REF|HEAD, UPSTREAM_REF)

set -euo pipefail

FORK_DIR="$(cd "$(dirname "$0")" && pwd)"
PATCH_DIR="$FORK_DIR/patches"
QUERY="$1"
UPSTREAM_REF="${UPSTREAM_REF:-upstream/main}"

if ! git rev-parse --verify --quiet "${UPSTREAM_REF}^{commit}" >/dev/null 2>&1; then
  echo "❌ $UPSTREAM_REF not available. Run: git fetch upstream main" >&2
  exit 2
fi
if [ -n "${FORK_REF:-}" ] && ! git rev-parse --verify --quiet "${FORK_REF}^{commit}" >/dev/null 2>&1; then
  echo "❌ FORK_REF not available: $FORK_REF" >&2
  exit 2
fi

if [ -n "${PATCH_BASE_REF:-}" ]; then
  if ! git rev-parse --verify --quiet "${PATCH_BASE_REF}^{commit}" >/dev/null 2>&1; then
    echo "❌ PATCH_BASE_REF not available: $PATCH_BASE_REF" >&2
    exit 2
  fi
  PATCH_BASE=$(git rev-parse "$PATCH_BASE_REF")
else
  PATCH_HEAD="${FORK_REF:-HEAD}"
  PATCH_BASE=$(git merge-base "$PATCH_HEAD" "$UPSTREAM_REF")
fi

# Match: exact filename > prefix glob > substring (fixed-string grep)
PATCH_FILE=""
for f in "$PATCH_DIR"/*.patch; do
  [ -f "$f" ] || continue
  base=$(basename "$f")
  if [ "$base" = "${QUERY}.patch" ] || [ "$base" = "$QUERY" ]; then
    PATCH_FILE="$f"
    break
  fi
done
if [ -z "$PATCH_FILE" ]; then
  PATCH_FILE=$(find "$PATCH_DIR" -maxdepth 1 -name "${QUERY}*.patch" -print | sort | head -1)
fi
if [ -z "$PATCH_FILE" ]; then
  PATCH_FILE=$(find "$PATCH_DIR" -maxdepth 1 -name "*.patch" -print | sort | grep -F "$QUERY" | head -1)
fi

if [ -z "$PATCH_FILE" ]; then
  echo "❌ No patch matching '$QUERY'" >&2
  echo "Available patches:" >&2
  ls "$PATCH_DIR"/*.patch 2>/dev/null | while read -r f; do echo "  $(basename "$f")"; done >&2
  exit 1
fi

mapfile -t FILES < <(grep '^diff --git' "$PATCH_FILE" | sed 's|diff --git a/\(.*\) b/.*|\1|' | sort -u)
if [ "${#FILES[@]}" -eq 0 ]; then
  echo "❌ Could not extract file list from $PATCH_FILE" >&2
  exit 1
fi

echo "Refreshing: $(basename "$PATCH_FILE")"
echo "Base: $(git rev-parse --short=9 "$PATCH_BASE")"
echo "Files:"
printf '%s\n' "${FILES[@]}" | while read -r f; do echo "  $f"; done

if [ -n "${FORK_REF:-}" ]; then
  git diff --binary --no-color "$PATCH_BASE" "$FORK_REF" -- "${FILES[@]}" > "${PATCH_FILE}.new"
else
  git diff --binary --no-color "$PATCH_BASE" -- "${FILES[@]}" > "${PATCH_FILE}.new"
fi

if [ -s "${PATCH_FILE}.new" ]; then
  mv "${PATCH_FILE}.new" "$PATCH_FILE"
  echo "✅ Refreshed: $(basename "$PATCH_FILE") ($(wc -l < "$PATCH_FILE") lines)"
else
  rm "${PATCH_FILE}.new"
  echo "⚠️ No diff found — upstream may now include this change."
  echo "   Consider removing this patch from the series file."
fi
