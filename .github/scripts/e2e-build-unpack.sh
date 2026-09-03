#!/usr/bin/env bash
# Restore the E2E build that e2e-build-pack.sh archived.
#
# Refuses an archive stamped with a different commit: a leg that silently
# tested another commit's bundle would report green for a tree nobody built.
#
# Usage: e2e-build-unpack.sh <archive-path>
# Run from the repository root. GITHUB_SHA must be set.
set -euo pipefail

archive="${1:?usage: e2e-build-unpack.sh <archive-path>}"
: "${GITHUB_SHA:?GITHUB_SHA must be set}"

stamp="$(tar -xzOf "$archive" e2e-build.sha)"
if [ "$stamp" != "${GITHUB_SHA}" ]; then
  echo "::error::build artifact was produced from ${stamp}, not ${GITHUB_SHA}"
  exit 1
fi
tar --exclude e2e-build.sha -xzf "$archive"
test -f dist/cli.js
rm -f "$archive"
