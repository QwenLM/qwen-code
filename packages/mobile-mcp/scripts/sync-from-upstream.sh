#!/usr/bin/env bash
# sync-from-upstream.sh — pull upstream mobile-mcp changes via git subtree.
#
# Usage:
#   packages/mobile-mcp/scripts/sync-from-upstream.sh [<branch-or-tag>]
#
# Default: pulls from 'main' branch of the mobile-mcp-upstream remote.
#
# Prerequisites:
#   git remote add mobile-mcp-upstream https://github.com/mobile-next/mobile-mcp.git
#
# After running: review the merge, resolve any conflicts in src/server.ts
# (our coord-norm hooks and new tools), and src/coord-norm.ts (new file,
# won't conflict). Then commit.
#
# If subtree pull becomes impractical (e.g. upstream history grows too large),
# fall back to the cua-driver approach: generate a diff between two refs in a
# local upstream clone and apply with `git apply --reject`.
set -euo pipefail

BRANCH="${1:-main}"
REMOTE="mobile-mcp-upstream"
PREFIX="packages/mobile-mcp"

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Ensure remote exists
if ! git remote | grep -q "^${REMOTE}$"; then
	echo "Adding remote ${REMOTE}..."
	git remote add "$REMOTE" https://github.com/mobile-next/mobile-mcp.git
fi

echo "Fetching ${REMOTE}..."
git fetch "$REMOTE"

echo "Pulling from ${REMOTE}/${BRANCH} into ${PREFIX}..."
git subtree pull --prefix="$PREFIX" "$REMOTE" "$BRANCH" --squash \
	-m "chore(mobile-mcp): sync with upstream ${REMOTE}/${BRANCH}"

# Update the vendored-from marker
UPSTREAM_SHA="$(git rev-parse "${REMOTE}/${BRANCH}")"
echo "$UPSTREAM_SHA" > "${PREFIX}/.vendored-from"
git add "${PREFIX}/.vendored-from"

echo ""
echo "Done. Upstream synced to ${UPSTREAM_SHA}."
echo "Review the merge, resolve any conflicts, then amend or commit."
