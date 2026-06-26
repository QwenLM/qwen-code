#!/usr/bin/env bash
#
# sync-from-upstream.sh — update this vendored copy of trycua/cua's
# `libs/cua-driver` by layering ONLY the upstream delta on top of our local
# changes (the 0–1000 relative-coordinate shim + the qwen-cua-driver rename),
# via a 3-way apply.
#
# Why not `git subtree`: `git subtree split` hangs on a commit deep in the
# trycua/cua history, so the subtree pull workflow is not usable for this repo.
# This script is the supported alternative — it never walks the full history,
# it just diffs the two refs you give it.
#
# Usage:
#   packages/cua-driver/scripts/sync-from-upstream.sh <new-ref> [<cua-repo-path>]
#
#   <new-ref>        trycua/cua tag/branch/commit to move to,
#                    e.g.  cua-driver-rs-v0.7.0
#   <cua-repo-path>  local clone of trycua/cua (default: $CUA_REPO env var).
#                    Must contain the upstream `libs/cua-driver/` tree.
#
# The upstream ref we are currently vendored from is recorded in
# `packages/cua-driver/.vendored-from` and updated on success.
#
# After running: review the diff, resolve any `<<<<<<<` conflict markers
# (only happen where upstream touched a line we changed), then commit.
set -euo pipefail

PKG="$(cd "$(dirname "$0")/.." && pwd)"               # packages/cua-driver
REPO_ROOT="$(git -C "$PKG" rev-parse --show-toplevel)"
VENDORED_FILE="$PKG/.vendored-from"

NEW_REF="${1:-}"
CUA_REPO="${2:-${CUA_REPO:-}}"

if [ -z "$NEW_REF" ]; then
  echo "usage: $0 <new-ref> [<cua-repo-path>]   (or set CUA_REPO)" >&2
  exit 2
fi
if [ -z "$CUA_REPO" ] || [ ! -d "$CUA_REPO/.git" ] && ! git -C "$CUA_REPO" rev-parse --git-dir >/dev/null 2>&1; then
  echo "error: pass a local trycua/cua clone path as arg 2, or set \$CUA_REPO." >&2
  echo "       (it must contain libs/cua-driver/ and the <new-ref> you want)" >&2
  exit 1
fi

OLD_REF="$(cat "$VENDORED_FILE" 2>/dev/null || echo cua-driver-rs-v0.6.7)"

echo "cua repo : $CUA_REPO"
echo "from     : $OLD_REF"
echo "to       : $NEW_REF"

# Make sure both refs resolve in the cua repo.
for r in "$OLD_REF" "$NEW_REF"; do
  git -C "$CUA_REPO" rev-parse --verify --quiet "$r^{commit}" >/dev/null \
    || { echo "error: ref '$r' not found in $CUA_REPO (git fetch the upstream first)"; exit 1; }
done

PATCH="$(mktemp -t cua-upstream.XXXXXX).patch"
trap 'rm -f "$PATCH"' EXIT

# Upstream delta for the driver only. --no-renames keeps the patch simple
# (rename = delete + add), which 3-way-applies more predictably.
git -C "$CUA_REPO" diff --no-renames "$OLD_REF" "$NEW_REF" -- libs/cua-driver > "$PATCH"

if [ ! -s "$PATCH" ]; then
  echo "No upstream changes to libs/cua-driver between $OLD_REF and $NEW_REF."
  echo "$NEW_REF" > "$VENDORED_FILE"
  exit 0
fi

# Reprefix a/libs/cua-driver/X -> packages/cua-driver/X:
#   -p3                strips the leading  a/libs/cua-driver/  (3 components)
#   --directory=...    prepends            packages/cua-driver/
#   --reject           apply every hunk that fits; write *.rej for the rest
#                      (used instead of --3way because the patch's base blobs
#                       live in the cua repo, not here, so a 3-way merge can't
#                       look them up — and plain apply is all-or-nothing).
cd "$REPO_ROOT"
if git apply --reject --directory=packages/cua-driver -p3 "$PATCH"; then
  echo "Applied cleanly."
  status=0
else
  echo
  echo "Some hunks didn't fit — upstream touched lines our patch also changed."
  echo "Each conflict is in a sibling '<file>.rej' under packages/cua-driver/."
  echo "Apply those hunks by hand, delete the .rej files, then commit. Find them with:"
  echo "  find packages/cua-driver -name '*.rej'"
  status=1
fi

echo "$NEW_REF" > "$VENDORED_FILE"
echo
echo "NOTE: we carry some not-yet-merged upstream PRs as cherry-picks — see"
echo "      packages/cua-driver/.vendored-patches.md. If <new-ref> is at/past"
echo "      the point any of them merged upstream, expect .rej on those files"
echo "      and drop the reconciled row from that table."
echo
echo "Review the result, then:"
echo "  git -C \"$REPO_ROOT\" add -A"
echo "  git -C \"$REPO_ROOT\" commit -m 'chore(cua-driver): sync vendored driver to $NEW_REF'"
exit "$status"
