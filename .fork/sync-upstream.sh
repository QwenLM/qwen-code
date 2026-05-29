#!/usr/bin/env bash
# .fork/sync-upstream.sh — Conflict-free upstream sync (LOCAL helper).
#
# NOTE: This is a LOCAL developer convenience script. The authoritative sync
# flow for CI is in .aoneci/upstream-sync-merge.yml, which uses a different
# strategy (direct merge + conflict detection + LLM resolution). Use this
# script for manual local syncs; do NOT use it as a substitute for the CI flow.
#
# Workflow:
#   1. Unapply all fork patches → working tree matches upstream
#   2. Merge upstream/main → no conflicts because tree = upstream
#   3. Re-apply fork patches
#   4. Rebuild lockfile
#   5. Verify and commit
#
# Usage:
#   bash .fork/sync-upstream.sh                    # full sync
#   bash .fork/sync-upstream.sh --dry-run          # check without committing
#
# Prerequisites:
#   git remote add upstream https://github.com/QwenLM/qwen-code.git

set -euo pipefail

FORK_DIR="$(cd "$(dirname "$0")" && pwd)"
DRY_RUN="${1:-}"
TODAY=$(date +%Y-%m-%d)

echo "========================================"
echo "  Fork Patch-Based Upstream Sync"
echo "  $TODAY"
echo "========================================"
echo ""

# Preflight
if ! git rev-parse --verify --quiet upstream/main >/dev/null 2>&1; then
  echo "❌ upstream/main not available. Run:"
  echo "   git remote add upstream https://github.com/QwenLM/qwen-code.git"
  echo "   git fetch upstream main"
  exit 2
fi

# Step 0: Checkpoint
echo "=== Step 0: Checkpoint ==="
CHECKPOINT=$(git rev-parse HEAD)
echo "HEAD: $(git log --oneline -1)"
git tag "sync-checkpoint-$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short=7 HEAD)" HEAD 2>/dev/null || true
echo ""

# Step 1: Unapply all fork patches
echo "=== Step 1: Unapply fork patches ==="
bash "$FORK_DIR/unapply.sh"
git add -A
git diff --cached --quiet || git commit -m "chore(sync): unapply fork patches for upstream merge"
echo ""

# Step 2: Fetch and merge upstream
echo "=== Step 2: Merge upstream ==="
if ! git fetch upstream main; then
  echo "❌ Failed to fetch upstream/main (network error?)" >&2
  exit 1
fi
UPSTREAM_HEAD=$(git rev-parse upstream/main)
echo "upstream/main: $(git log --oneline -1 upstream/main)"

NEW_COMMITS=$(git log --oneline HEAD..upstream/main --no-merges | wc -l | tr -d ' ')
if [ "$NEW_COMMITS" -eq 0 ]; then
  echo "✅ Already up-to-date with upstream. Re-applying patches..."
  if ! node "$FORK_DIR/rewrite-package-identity.js" || ! bash "$FORK_DIR/apply.sh"; then
    echo ""
    echo "⚠️ Re-apply failed after unapply. Repo is in unapply state."
    echo "   Restore with: git reset --hard $CHECKPOINT"
    exit 1
  fi
  git add -A
  git diff --cached --quiet || git commit -m "chore(sync): re-apply fork patches"
  echo "Done — no upstream changes."
  exit 0
fi

echo "📦 $NEW_COMMITS new upstream commits"
if ! git merge upstream/main --no-edit; then
  echo ""
  echo "❌ UNEXPECTED: merge conflict after unapply!"
  echo "   This means a fork-only file conflicts with upstream."
  echo "   Conflicted files:"
  git diff --name-only --diff-filter=U
  echo ""
  echo "   Aborting merge to leave repo in a clean state."
  git merge --abort 2>/dev/null || true
  echo "   Resolve manually, then re-run this script."
  exit 1
fi
echo ""

# Step 3: Re-apply fork patches
echo "=== Step 3: Apply fork patches ==="
node "$FORK_DIR/rewrite-package-identity.js"

APPLY_RC=0
bash "$FORK_DIR/apply.sh" --continue || APPLY_RC=$?

if [ "$APPLY_RC" -ne 0 ]; then
  echo ""
  echo "⚠️ Some patches failed to apply."
  echo "   Fix the .rej files, then run:"
  echo "     bash .fork/refresh-patch.sh <patch-name>"
  echo "   to update the patch, then:"
  echo "     git add -A && git commit -m 'chore: sync upstream $TODAY'"
  if [ "$DRY_RUN" = "--dry-run" ]; then
    echo ""
    echo "DRY RUN: resetting to checkpoint..."
    git reset --hard "$CHECKPOINT"
  fi
  exit 1
fi
echo ""

# Step 4: Commit
echo "=== Step 4: Commit ==="
git add -A
if git diff --cached --quiet; then
  echo "✅ No changes to commit"
else
  if [ "$DRY_RUN" = "--dry-run" ]; then
    echo "DRY RUN: would commit 'chore: sync upstream $TODAY ($NEW_COMMITS commits)'"
    echo "Resetting to checkpoint..."
    git reset --hard "$CHECKPOINT"
  else
    git commit -m "chore: sync upstream ${TODAY} (${NEW_COMMITS:-0} commits)"
  fi
fi

echo ""
echo "✅ Upstream sync complete"
echo "   $NEW_COMMITS commits merged, all patches applied successfully."
