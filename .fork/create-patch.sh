#!/usr/bin/env bash
# .fork/create-patch.sh — Create a new patch from current modifications.
#
# Usage:
#   bash .fork/create-patch.sh <name> <file1> [file2 ...]
#
# Example:
#   bash .fork/create-patch.sh my-feature packages/core/src/foo.ts packages/core/src/bar.ts
#
# Environment:
#   UPSTREAM_REF     default upstream/main
#   FORK_REF         optional committed fork ref to diff, for example origin/main
#   PATCH_BASE_REF   optional explicit base; defaults to merge-base(FORK_REF|HEAD, UPSTREAM_REF)

set -euo pipefail

FORK_DIR="$(cd "$(dirname "$0")" && pwd)"
PATCH_DIR="$FORK_DIR/patches"
SERIES="$PATCH_DIR/series"
UPSTREAM_REF="${UPSTREAM_REF:-upstream/main}"

if [ $# -lt 2 ]; then
  echo "Usage: $0 <patch-name> <file1> [file2 ...]" >&2
  exit 1
fi

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

NAME="$1"; shift
FILES=("$@")

LAST_NUM=$(ls "$PATCH_DIR"/*.patch 2>/dev/null | sort | tail -1 | xargs -I{} basename {} | grep -oE '^[0-9]{4}' || echo "0000")
NEXT_NUM=$(printf "%04d" $(( 10#$LAST_NUM + 1 )))
PATCH_FILE="$PATCH_DIR/${NEXT_NUM}-${NAME}.patch"

if [ -n "${FORK_REF:-}" ]; then
  git diff --binary --no-color "$PATCH_BASE" "$FORK_REF" -- "${FILES[@]}" > "$PATCH_FILE"
else
  git diff --binary --no-color "$PATCH_BASE" -- "${FILES[@]}" > "$PATCH_FILE"
fi

if [ -s "$PATCH_FILE" ]; then
  echo "${NEXT_NUM}-${NAME}.patch" >> "$SERIES"
  echo "✅ Created: $(basename "$PATCH_FILE") ($(wc -l < "$PATCH_FILE") lines)"
  echo "   Base: $(git rev-parse --short=9 "$PATCH_BASE")"
  echo "   Added to series file"
  echo ""
  echo "Files in patch:"
  printf '%s\n' "${FILES[@]}" | while read -r f; do echo "  $f"; done
else
  rm "$PATCH_FILE"
  echo "❌ No diff found for specified files" >&2
  exit 1
fi
