#!/usr/bin/env bash
# Pack one E2E build for every leg of e2e.yml to unpack.
#
# Each leg used to run `npm run build` and `npm run bundle` itself: 4–8
# minutes on a hosted VM, 10–17 on a busy pool host, eleven times per run.
# The outputs are platform-independent JavaScript, so the `build` job runs
# this once and uploads the archive; e2e-build-unpack.sh restores it.
#
# The archive holds the bundle (dist/), every workspace dist/ the tests or
# the bundle resolve through node_modules symlinks, and a stamp of the commit
# it was built from so a leg can refuse a tree from another commit. tar keeps
# file modes, which the artifact store does not.
#
# Usage: e2e-build-pack.sh <archive-path>
# Run from the repository root after build and bundle. GITHUB_SHA must be set.
set -euo pipefail

archive="${1:?usage: e2e-build-pack.sh <archive-path>}"
: "${GITHUB_SHA:?GITHUB_SHA must be set}"

if [ ! -f dist/cli.js ]; then
  echo "::error::dist/cli.js not found — run e2e-build-pack.sh from the repository root after npm run build && npm run bundle" >&2
  exit 1
fi

# The workspace roots come from package.json, not from a copy kept here: a
# new top-level root (say plugins/*) is scanned the day it is added to
# `workspaces`, instead of silently missing from the archive.
roots="$(node -e '
  const { workspaces = [] } = require("./package.json");
  const roots = new Set(
    workspaces.filter((w) => !w.startsWith("!")).map((w) => w.split("/")[0]),
  );
  process.stdout.write([...roots].join("\n"));
')"
if [ -z "$roots" ]; then
  echo "::error::package.json declares no workspaces; nothing to pack" >&2
  exit 1
fi

# The stamp sits at the archive root, so it is written into the tree for the
# duration of the pack and removed afterwards; a local run leaves nothing
# behind. One -T list and no positional names: that is the form GNU tar and
# bsdtar (macOS) read the same way.
list="$(mktemp)"
trap 'rm -f e2e-build.sha "$list"' EXIT
printf '%s' "${GITHUB_SHA}" > e2e-build.sha
{
  printf '%s\n' e2e-build.sha dist
  # node_modules is pruned so a dependency's own dist/ never rides along;
  # a matched dist/ is pruned so nothing nested under it is listed twice.
  # shellcheck disable=SC2086 # $roots is a newline list of directory names
  find $roots -type d -name node_modules -prune -o -type d -name dist -prune -print
} > "$list"
# Fail closed on a silent under-pack: if find contributed nothing beyond the
# stamp and the bundle (a dropped `-o` turns the two -prune clauses into one
# conjunction that matches nothing), tar would still succeed and the missing
# outputs would surface as module-resolution errors on every leg instead
# of here. Same contract as release.yml's Pack Build Outputs.
if [ "$(wc -l < "$list")" -le 2 ]; then
  echo "::error::e2e-build-pack.sh found no workspace dist/ under: $(tr '\n' ' ' < <(printf '%s' "$roots"))" >&2
  exit 1
fi
tar -czf "$archive" -T "$list"
ls -l "$archive"
