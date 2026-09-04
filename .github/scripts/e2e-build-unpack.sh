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

# Three states an operator must tell apart: the download never landed
# (the step's path and this argument drifted), the file is not a readable
# gzip tarball (truncated upload), or the archive has no stamp member.
if [ ! -f "$archive" ]; then
  echo "::error::build artifact not found at $archive — check the Download build artifact step's path"
  exit 1
fi
tar_err="$(mktemp)"
trap 'rm -f "$tar_err"' EXIT
if ! stamp="$(tar -xzOf "$archive" e2e-build.sha 2> "$tar_err")"; then
  echo "::error::cannot read the e2e-build.sha stamp from $archive — the archive is corrupt, truncated, or not one e2e-build-pack.sh produced: $(tr '\n' ' ' < "$tar_err")"
  exit 1
fi
if [ "$stamp" != "${GITHUB_SHA}" ]; then
  echo "::error::build artifact was produced from ${stamp}, not ${GITHUB_SHA}"
  exit 1
fi
# The whole listing is read into a variable first. Piping tar into
# `grep -q` would let grep exit at the first match while tar is still
# writing: tar then dies of SIGPIPE, pipefail reports 141, and every real
# archive (14k members, the bundle listed first) is refused. No guard on
# this read: extracting the stamp above already ran the whole stream, so
# an archive that lists badly here never got past that check.
listing="$(tar -tzf "$archive")"
if ! grep -qx 'dist/cli.js' <<< "$listing"; then
  echo "::error::build artifact holds no dist/cli.js — the pack step shipped an archive without the bundle"
  exit 1
fi
tar --exclude e2e-build.sha -xzf "$archive"
if [ ! -f dist/cli.js ]; then
  echo "::error::dist/cli.js missing after unpack — run e2e-build-unpack.sh from the repository root"
  exit 1
fi
rm -f "$archive"
