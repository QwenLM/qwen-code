#!/usr/bin/env bash
# Pack one E2E build for every leg of e2e.yml to unpack.
#
# Each leg used to run `npm run build` and `npm run bundle` itself: 4–8
# minutes on a hosted VM, 10–17 on a busy pool host, eleven times per run.
# The outputs are platform-independent JavaScript, so the `build` job runs
# this once and uploads the archive; e2e-build-unpack.sh restores it.
#
# The archive holds the bundle (dist/) and every workspace dist/ the tests or
# the bundle resolve through node_modules symlinks, plus a stamp of the
# commit it was built from so a leg can refuse a tree from another commit.
# tar keeps file modes, which the artifact store does not.
#
# Usage: e2e-build-pack.sh <archive-path>
# Run from the repository root after build and bundle. GITHUB_SHA must be set.
set -euo pipefail

archive="${1:?usage: e2e-build-pack.sh <archive-path>}"
: "${GITHUB_SHA:?GITHUB_SHA must be set}"

test -f dist/cli.js

# The stamp sits at the archive root, so it is written into the tree for the
# duration of the pack and removed afterwards; a local run leaves nothing
# behind. One -T list and no positional names: that is the form GNU tar and
# bsdtar (macOS) read the same way.
list="$(mktemp)"
trap 'rm -f e2e-build.sha "$list"' EXIT
printf '%s' "${GITHUB_SHA}" > e2e-build.sha
{
  printf '%s\n' e2e-build.sha dist
  # node_modules is pruned so a dependency's own dist/ never rides along.
  find packages integrations -name node_modules -prune -o -type d -name dist -print
} > "$list"
tar -czf "$archive" -T "$list"
ls -l "$archive"
