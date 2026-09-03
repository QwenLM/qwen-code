#!/usr/bin/env bash
# Restore the E2E build that e2e-build-pack.sh archived.
#
# Refuses an archive stamped with a different commit, and one without the
# bundle, before extracting anything: a leg that silently tested another
# commit's bundle — or no bundle — would report on a tree nobody built.
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
if ! tar -tzf "$archive" | grep -qx 'dist/cli.js'; then
  echo "::error::build artifact holds no dist/cli.js — the pack step shipped an archive without the bundle"
  exit 1
fi
tar --exclude e2e-build.sha -xzf "$archive"
if [ ! -f dist/cli.js ]; then
  echo "::error::dist/cli.js missing after unpack — run e2e-build-unpack.sh from the repository root"
  exit 1
fi
rm -f "$archive"
